// Shared config, ABIs and helpers for the x402-aevum server and agent.
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const AEVUM = {
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "Test QDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  testnet: true,
};

export const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TUSD8_DECIMALS = 6;
export const CHAIN_TAG = `eip155:${AEVUM.id}`; // CAIP-2 network id used in challenges

export const tusd8Domain = (chainId, token) => ({
  name: "tUSD8",
  version: "2",
  chainId,
  verifyingContract: token,
});

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export const gateAbi = parseAbi([
  "function token() view returns (address)",
  "function merchant() view returns (address)",
  "function authorizationNonce(bytes32 orderId) view returns (bytes32)",
  "function settle(bytes32 orderId, bytes32 resourceHash, uint256 amount)",
  "function settleWithAuthorization(bytes32 orderId, bytes32 resourceHash, address from, uint256 amount, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function receiptOf(bytes32 orderId) view returns ((address payer, bytes32 resourceHash, uint256 amount, uint64 paidAt))",
  "function isSettled(bytes32 orderId) view returns (bool)",
  "function spentOf(address) view returns (uint256)",
  "function totalSettled() view returns (uint256)",
  "function settleCount() view returns (uint256)",
  "event Settled(bytes32 indexed orderId, address indexed payer, bytes32 resourceHash, uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const explorerTx = (h) => `${AEVUM.blockExplorers.default.url}/tx/${h}`;
export const explorerAddr = (a) => `${AEVUM.blockExplorers.default.url}/address/${a}`;

export function publicClient(rpcUrl) {
  return createPublicClient({ chain: { ...AEVUM, rpcUrls: { default: { http: [rpcUrl || AEVUM.rpcUrls.default.http[0]] } } }, transport: http() });
}

export function walletClientFrom(key, rpcUrl) {
  const account = privateKeyToAccount(key);
  return {
    account,
    wallet: createWalletClient({
      account,
      chain: { ...AEVUM, rpcUrls: { default: { http: [rpcUrl || AEVUM.rpcUrls.default.http[0]] } } },
      transport: http(),
    }),
  };
}

/** keccak256(orderSeed) — server-side orderId derivation. */
import { keccak256, encodePacked, toHex } from "viem";
export function makeOrderId(resourceHash, payerHint = "0x0000000000000000000000000000000000000000", seed) {
  return keccak256(encodePacked(["bytes32", "address", "uint256"], [resourceHash, payerHint, BigInt(seed)]));
}

export function resourceHashOf(descriptor) {
  return keccak256(toHex(descriptor));
}

export const b64 = {
  enc: (o) => Buffer.from(JSON.stringify(o)).toString("base64"),
  dec: (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8")),
};
