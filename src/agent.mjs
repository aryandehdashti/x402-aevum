// The paying agent: requests a resource, gets 402, signs EIP-3009, retries paid.
// Needs tUSD8 balance but ZERO gas — the server relays the settlement.
//
//   AGENT_KEY=0x... node src/agent.mjs http://localhost:4405 /r/payment-readiness?url=x402.thefirstwall.ai
import {
  AEVUM, CHAIN_TAG, tusd8Domain, RECEIVE_WITH_AUTHORIZATION_TYPES,
  gateAbi, publicClient, walletClientFrom, b64,
} from "./lib.mjs";

const [, , baseUrl = "http://localhost:4405", resource = "/r/chain-stats"] = process.argv;
const AGENT_KEY = process.env.AGENT_KEY;
const RPC_URL = process.env.RPC_URL;
if (!AGENT_KEY) { console.error("AGENT_KEY required (agent's private key — test wallet only)"); process.exit(1); }

const pub = publicClient(RPC_URL);
const { account: agent } = walletClientFrom(AGENT_KEY, RPC_URL);
const url = baseUrl.replace(/\/$/, "") + resource;
const now = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${now()}]`, ...a);

// 1. request the resource — expect 402
const r1 = await fetch(url);
log(`GET ${url} -> ${r1.status}`);
if (r1.status !== 402) {
  console.log(await r1.text());
  process.exit(r1.status === 200 ? 0 : 1);
}
const challenge = await r1.json();
const req402 = challenge.accepts[0];
log(`402 challenge: ${req402.amount} base units tUSD8 via ${req402.scheme} on ${req402.network}`);
log(`orderId ${req402.orderId}`);

// 2. build + sign the EIP-3009 ReceiveWithAuthorization
const nonce = await pub.readContract({
  address: req402.payGate, abi: gateAbi, functionName: "authorizationNonce", args: [req402.orderId],
});
const message = {
  from: agent.address,
  to: req402.payGate,
  value: BigInt(req402.amount),
  validAfter: 0n,
  validBefore: BigInt(req402.validBefore),
  nonce,
};
const domain = tusd8Domain(AEVUM.id, req402.asset);
const sig = await agent.signTypedData({
  domain, types: RECEIVE_WITH_AUTHORIZATION_TYPES,
  primaryType: "ReceiveWithAuthorization", message,
});
// split v/r/s
const r = sig.slice(0, 66);
const s = "0x" + sig.slice(66, 130);
const v = parseInt(sig.slice(130, 132), 16);
log(`signed ReceiveWithAuthorization v=${v}`);

// 3. retry with payment
const payment = {
  scheme: req402.scheme,
  network: req402.network,
  orderId: req402.orderId,
  payload: {
    from: agent.address, value: req402.amount,
    validAfter: "0", validBefore: String(req402.validBefore),
    nonce, v, r, s,
  },
};
const r2 = await fetch(url, { headers: { "X-PAYMENT": b64.enc(payment) } });
const body = await r2.json();
log(`GET (paid) -> ${r2.status}`);
console.log(JSON.stringify(body, null, 2));
if (r2.status === 200 && body.settlement) {
  log(`SETTLED on-chain: ${body.settlement.txHash}`);
  log(`explorer: ${body.settlement.explorer}`);
  log(`receipt: ${baseUrl}${body.settlement.receiptUrl}`);
}
