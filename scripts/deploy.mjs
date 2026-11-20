// Deploy a compiled contract artifact. Usage:
//   DEPLOYER_KEY=0x... node scripts/deploy.mjs X402Gate <token> <merchant>
//   DEPLOYER_KEY=0x... node scripts/deploy.mjs MockUSD8
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { publicClient, walletClientFrom } from "../src/lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [, , name = "X402Gate", ...args] = process.argv;
const KEY = process.env.DEPLOYER_KEY;
const RPC_URL = process.env.RPC_URL;
if (!KEY) { console.error("DEPLOYER_KEY required"); process.exit(1); }

const artifact = JSON.parse(readFileSync(join(ROOT, "artifacts", name + ".json"), "utf8"));
const pub = publicClient(RPC_URL);
const { account, wallet } = walletClientFrom(KEY, RPC_URL);

const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
console.log("deploy tx:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log(`${name} deployed at ${receipt.contractAddress} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
