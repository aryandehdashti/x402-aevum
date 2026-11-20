// Compiles contracts/X402Gate.sol (+ MockUSD8 for local tests) with solc-js.
// Output: artifacts/<Name>.json { abi, bytecode }
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTRACTS = join(ROOT, "contracts");
const OUT = join(ROOT, "artifacts");
mkdirSync(OUT, { recursive: true });

const sources = {};
for (const f of ["X402Gate.sol", "MockUSD8.sol"]) {
  sources[f] = { content: readFileSync(join(CONTRACTS, f), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    evmVersion: "shanghai", // Aevum is Shanghai — no MCOPY/TSTORE/blobs
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
let failed = false;
for (const e of out.errors ?? []) {
  console.error(e.severity.toUpperCase(), e.formattedMessage);
  if (e.severity === "error") failed = true;
}
if (failed) process.exit(1);

for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    const artifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
    writeFileSync(join(OUT, name + ".json"), JSON.stringify(artifact, null, 2));
    console.log(`compiled ${name} (${artifact.bytecode.length / 2 - 1} bytes)`);
  }
}
