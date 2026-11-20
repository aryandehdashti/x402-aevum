// x402 resource server on QDay Aevum.
//
//   GET /r/<resource>            -> 402 challenge  (or 200 resource with X-PAYMENT)
//   GET /receipt/<orderId>       -> on-chain settlement receipt (public audit trail)
//   GET /stats                   -> gate counters
//   GET /health                  -> liveness + config (no secrets)
//
// Flow: client requests a priced resource, gets 402 + payment requirements,
// signs an EIP-3009 ReceiveWithAuthorization for tUSD8, retries with the
// X-PAYMENT header; the server verifies the signature, relays it to
// X402Gate.settleWithAuthorization (server pays gas), waits for settlement,
// then serves the resource plus a settlement receipt.
import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  AEVUM, TUSD8, TUSD8_DECIMALS, CHAIN_TAG, tusd8Domain,
  RECEIVE_WITH_AUTHORIZATION_TYPES, gateAbi,
  publicClient, walletClientFrom, makeOrderId, resourceHashOf,
  explorerTx, explorerAddr, b64,
} from "./lib.mjs";
import { getAddress, recoverTypedDataAddress } from "viem";
import { readinessProbe } from "./readiness.mjs";

const env = process.env;
const PORT = Number(env.PORT || 4405);
const RPC_URL = env.RPC_URL || AEVUM.rpcUrls.default.http[0];
const GATE = env.GATE_ADDRESS;
const TOKEN = env.TOKEN_ADDRESS || TUSD8;
const RELAYER_KEY = env.RELAYER_KEY;      // pays gas for settlements (tQDAY)
const PRICE = BigInt(env.PRICE_BASE_UNITS || "25000"); // 0.025 tUSD8
const CHALLENGE_TTL = Number(env.CHALLENGE_TTL_SECS || 600);

if (!GATE) { console.error("GATE_ADDRESS required"); process.exit(1); }
if (!RELAYER_KEY) { console.error("RELAYER_KEY required"); process.exit(1); }

const pub = publicClient(RPC_URL);
const { account: relayer, wallet } = walletClientFrom(RELAYER_KEY, RPC_URL);

// priced resources: each has a resourceHash bound into the on-chain receipt
const RESOURCES = {
  "payment-readiness": {
    price: PRICE,
    describe: "x402 payment-readiness probe of a target URL (verdict + defects)",
    serve: async (req, url) => {
      const target = url.searchParams.get("url");
      if (!target) return { error: "missing ?url=" };
      return readinessProbe(target);
    },
  },
  "chain-stats": {
    price: PRICE / 5n, // cheaper: 0.005
    describe: "live gate counters + merchant balance readout",
    serve: async () => {
      const [total, count] = await Promise.all([
        pub.readContract({ address: GATE, abi: gateAbi, functionName: "totalSettled" }),
        pub.readContract({ address: GATE, abi: gateAbi, functionName: "settleCount" }),
      ]);
      return { totalSettled: total.toString(), settleCount: count.toString() };
    },
  },
};

// pending challenges: orderId -> {resourceHash, amount, resource, expiresAt}
const pending = new Map();
const GC_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of pending) if (c.expiresAt < now) pending.delete(id);
}, GC_MS).unref();

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(body);
}

function issue402(res, slug, cfg) {
  const resourceHash = resourceHashOf(`/r/${slug}`);
  const seed = BigInt("0x" + randomBytes(16).toString("hex"));
  const orderId = makeOrderId(resourceHash, "0x0000000000000000000000000000000000000000", seed);
  const validBefore = Math.floor(Date.now() / 1000) + CHALLENGE_TTL;
  pending.set(orderId, {
    resourceHash, amount: cfg.price, resource: `/r/${slug}`,
    expiresAt: Date.now() + CHALLENGE_TTL * 1000,
  });
  send(res, 402, {
    x402Version: 1,
    error: "Payment required to access this resource",
    accepts: [{
      scheme: "eip3009-gate",
      network: CHAIN_TAG,
      asset: TOKEN,
      assetName: "tUSD8",
      assetDecimals: TUSD8_DECIMALS,
      payGate: GATE,
      amount: cfg.price.toString(),
      orderId,
      validBefore,
      resource: `/r/${slug}`,
      resourceHash,
      description: cfg.describe,
      eip3009: {
        domain: tusd8Domain(AEVUM.id, TOKEN),
        types: RECEIVE_WITH_AUTHORIZATION_TYPES,
        primaryType: "ReceiveWithAuthorization",
        note: "sign ReceiveWithAuthorization{from:you,to:payGate,value:amount,validAfter:0,validBefore,nonce:gate.authorizationNonce(orderId)}",
      },
    }],
  });
}

async function verifySignature(p) {
  // recover the signer of the EIP-3009 typed data — pre-check before paying gas
  const msg = {
    from: p.from, to: GATE, value: BigInt(p.value),
    validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore),
    nonce: p.nonce,
  };
  const signature = p.signature ?? `${p.r}${p.s.slice(2)}${p.v.toString(16).padStart(2, "0")}`;
  const recovered = await recoverTypedDataAddress({
    domain: tusd8Domain(AEVUM.id, TOKEN),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: msg,
    signature,
  });
  return getAddress(recovered) === getAddress(p.from);
}

async function settleOnChain(orderId, resourceHash, p) {
  const args = [orderId, resourceHash, p.from, BigInt(p.value), BigInt(p.validAfter), BigInt(p.validBefore), p.v, p.r, p.s];
  // simulate first: surfaces underfunded-balance / used-nonce / expiry without burning gas
  await pub.simulateContract({ address: GATE, abi: gateAbi, functionName: "settleWithAuthorization", args, account: relayer });
  const hash = await wallet.writeContract({ address: GATE, abi: gateAbi, functionName: "settleWithAuthorization", args });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, receipt };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (path === "/health") {
      return send(res, 200, {
        ok: true, chain: CHAIN_TAG, gate: GATE, token: TOKEN,
        relayer: relayer.address, explorer: explorerAddr(GATE),
        resources: Object.keys(RESOURCES),
      });
    }
    if (path.startsWith("/receipt/")) {
      const orderId = path.split("/")[2];
      const r = await pub.readContract({ address: GATE, abi: gateAbi, functionName: "receiptOf", args: [orderId] });
      if (r.payer === "0x0000000000000000000000000000000000000000")
        return send(res, 404, { settled: false, orderId });
      return send(res, 200, {
        settled: true, orderId, payer: r.payer, resourceHash: r.resourceHash,
        amount: r.amount.toString(), paidAt: Number(r.paidAt),
        verifyOnChain: { gate: GATE, call: `receiptOf(${orderId})`, explorer: explorerAddr(GATE) },
      });
    }
    if (path === "/stats") {
      const [total, count] = await Promise.all([
        pub.readContract({ address: GATE, abi: gateAbi, functionName: "totalSettled" }),
        pub.readContract({ address: GATE, abi: gateAbi, functionName: "settleCount" }),
      ]);
      return send(res, 200, { totalSettled: total.toString(), settleCount: count.toString(), gate: GATE, token: TOKEN });
    }
    const m = path.match(/^\/r\/([a-z0-9-]+)$/);
    if (m) {
      const slug = m[1];
      const cfg = RESOURCES[slug];
      if (!cfg) return send(res, 404, { error: "unknown resource", resources: Object.keys(RESOURCES) });

      const payHeader = req.headers["x-payment"];
      if (!payHeader) return issue402(res, slug, cfg);

      // verify + settle
      let p;
      try { p = b64.dec(payHeader); } catch { return send(res, 400, { error: "malformed X-PAYMENT" }); }
      const chall = pending.get(p.orderId);
      if (!chall) return send(res, 402, { error: "unknown or expired orderId — request a fresh challenge" });
      if (p.scheme !== "eip3009-gate" || p.network !== CHAIN_TAG)
        return send(res, 400, { error: "wrong scheme/network", want: { scheme: "eip3009-gate", network: CHAIN_TAG } });
      const pay = p.payload || p;
      if (BigInt(pay.value) !== chall.amount)
        return send(res, 400, { error: "amount mismatch", want: chall.amount.toString() });
      const expectedNonce = await pub.readContract({ address: GATE, abi: gateAbi, functionName: "authorizationNonce", args: [p.orderId] });
      if (pay.nonce !== expectedNonce)
        return send(res, 400, { error: "nonce mismatch", want: expectedNonce });
      if (!(await verifySignature(pay)))
        return send(res, 400, { error: "signature does not recover to `from`" });

      const { hash } = await settleOnChain(p.orderId, chall.resourceHash, {
        ...pay, from: getAddress(pay.from),
      });
      pending.delete(p.orderId);
      const resource = await cfg.serve(req, url);
      return send(res, 200, {
        resource: chall.resource,
        data: resource,
        settlement: {
          orderId: p.orderId,
          txHash: hash,
          explorer: explorerTx(hash),
          receiptUrl: `/receipt/${p.orderId}`,
          payer: pay.from,
          amount: chall.amount.toString(),
        },
      }, { "X-PAYMENT-RESPONSE": b64.enc({ orderId: p.orderId, txHash: hash, explorer: explorerTx(hash) }) });
    }
    return send(res, 404, { error: "not found", paths: ["/health", "/stats", "/r/<resource>", "/receipt/<orderId>"] });
  } catch (e) {
    const msg = e?.shortMessage || e?.message || String(e);
    const code = /insufficient|revert|expired|rejected/i.test(msg) ? 402 : 500;
    return send(res, code, { error: "settlement failed", detail: msg.slice(0, 300) });
  }
});

server.listen(PORT, () => console.log(`x402-aevum server :${PORT} gate=${GATE} chain=${CHAIN_TAG}`));
