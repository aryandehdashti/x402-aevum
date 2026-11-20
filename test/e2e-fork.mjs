// Fork e2e: runs against an anvil fork of live Aevum with the REAL tUSD8.
//   anvil --fork-url https://rpc-test.qday.info --fork-block-number <N> --chain-id 44005 --hardfork shanghai --port 8545
//   node test/e2e-fork.mjs
// Prereq: agent wallet already holds tUSD8 on the fork (impersonated transfer).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { erc20Abi, gateAbi, publicClient, walletClientFrom } from "../src/lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RPC = "http://127.0.0.1:8545";
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const RELAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MERCHANT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

// agent = the challenge wallet (key from ../wallet_testnet.json)
const wfile = JSON.parse(readFileSync(join(ROOT, "..", "wallet_testnet.json"), "utf8"));
const AGENT_KEY = wfile.key.startsWith("0x") ? wfile.key : "0x" + wfile.key;

const pub = publicClient(RPC);
const relayer = walletClientFrom(RELAYER_KEY, RPC);
const agent = walletClientFrom(AGENT_KEY, RPC);
const merchant = walletClientFrom(MERCHANT_KEY, RPC);

const art = JSON.parse(readFileSync(join(ROOT, "artifacts", "X402Gate.json"), "utf8"));
const hash = await relayer.wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [TUSD8, merchant.account.address] });
const rc = await pub.waitForTransactionReceipt({ hash });
const gate = rc.contractAddress;
console.log("X402Gate (real tUSD8):", gate);

const bal = await pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [agent.account.address] });
const mbalBefore = await pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [merchant.account.address] });
console.log(`agent ${agent.account.address} tUSD8: ${(Number(bal) / 1e6).toFixed(6)}`);
if (bal < 5000n) { console.error("agent needs >=0.005 tUSD8 on fork — fund via impersonated transfer first"); process.exit(1); }

const env = { ...process.env, PORT: "4405", RPC_URL: RPC, GATE_ADDRESS: gate, TOKEN_ADDRESS: TUSD8, RELAYER_KEY, PRICE_BASE_UNITS: "25000" };
const srv = spawn("node", [join(ROOT, "src", "server.mjs")], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((r) => srv.stdout.on("data", (d) => { if (String(d).includes("server")) r(); setTimeout(r, 1500); }));

const ag = spawn("node", [join(ROOT, "src", "agent.mjs"), "http://localhost:4405", "/r/chain-stats"], { env: { ...env, AGENT_KEY }, stdio: "inherit" });
const code = await new Promise((r) => ag.on("close", r));

const [count, spent, mbal] = await Promise.all([
  pub.readContract({ address: gate, abi: gateAbi, functionName: "settleCount" }),
  pub.readContract({ address: gate, abi: gateAbi, functionName: "spentOf", args: [agent.account.address] }),
  pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [merchant.account.address] }),
]);
const settled = mbal - mbalBefore;
console.log(`settleCount=${count} spentOf(agent)=${spent} merchantDelta=${settled}`);
srv.kill();
const pass = code === 0 && count === 1n && spent === 5000n && settled === 5000n;
console.log(pass ? "FORK E2E PASS" : "FORK E2E FAIL");
process.exit(pass ? 0 : 1);
