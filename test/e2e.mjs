// End-to-end test on a local anvil chain (chain id 44005 so EIP-712 domains match).
//   anvil --chain-id 44005 --port 8545 &
//   node test/e2e.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseAbi } from "viem";
import { erc20Abi, gateAbi, publicClient, walletClientFrom, explorerTx } from "../src/lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RPC = "http://127.0.0.1:8545";

// anvil default accounts
const RELAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // acct0
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";  // acct1
const MERCHANT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // acct2

const pub = publicClient(RPC);
const relayer = walletClientFrom(RELAYER_KEY, RPC);
const agent = walletClientFrom(AGENT_KEY, RPC);
const merchant = walletClientFrom(MERCHANT_KEY, RPC);

const deploy = async (name, args) => {
  const a = JSON.parse(readFileSync(join(ROOT, "artifacts", name + ".json"), "utf8"));
  const hash = await relayer.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`${name}: ${rc.contractAddress}`);
  return rc.contractAddress;
};

const token = await deploy("MockUSD8", []);
const gate = await deploy("X402Gate", [token, merchant.account.address]);

// mint 10 tUSD8 to the agent
await relayer.wallet.writeContract({ address: token, abi: erc20Abi, functionName: "mint", args: [agent.account.address, 10_000_000n] });
const bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [agent.account.address] });
console.log("agent tUSD8:", (Number(bal) / 1e6).toFixed(6));

// start the server
const env = {
  ...process.env,
  PORT: "4405", RPC_URL: RPC, GATE_ADDRESS: gate, TOKEN_ADDRESS: token,
  RELAYER_KEY, PRICE_BASE_UNITS: "25000",
};
const srv = spawn("node", [join(ROOT, "src", "server.mjs")], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => srv.stdout.on("data", (d) => { if (String(d).includes("server")) r(); setTimeout(r, 1500); }));

// run the agent flow inline via the agent script
const ag = spawn("node", [join(ROOT, "src", "agent.mjs"), "http://localhost:4405", "/r/payment-readiness?url=example.com"], { env: { ...env, AGENT_KEY }, stdio: "inherit" });
const code = await new Promise((r) => ag.on("close", r));

// verify settlement
const [count, total, spent] = await Promise.all([
  pub.readContract({ address: gate, abi: gateAbi, functionName: "settleCount" }),
  pub.readContract({ address: gate, abi: gateAbi, functionName: "totalSettled" }),
  pub.readContract({ address: gate, abi: gateAbi, functionName: "spentOf", args: [agent.account.address] }),
]);
const mbal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [merchant.account.address] });
console.log(`settleCount=${count} totalSettled=${total} spentOf(agent)=${spent} merchantBal=${mbal}`);

srv.kill();
if (code === 0 && count === 1n && total === 25000n && mbal === 25000n) {
  console.log("E2E PASS");
} else {
  console.log("E2E FAIL", { code });
  process.exit(1);
}
