# x402-aevum — machine payments over HTTP-402 in tUSD8

**Aevum Builder Challenge #1 entry.** An agent calls a paywalled API, receives an
HTTP `402 Payment Required` challenge, signs an EIP-3009 authorization, and a
relayer settles the payment on-chain — no gas needed in the agent's wallet, and
every payment produces a publicly verifiable on-chain receipt.

- **Chain:** QDay Aevum Testnet — chain ID `44005`, RPC `https://rpc-test.qday.info`,
  explorer `https://explorer-test.qday.info`, gas token `tQDAY`
- **Token:** test stablecoin **tUSD8** (ERC-20, 6 decimals, EIP-2612 + EIP-3009) at
  [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483)
- **Contract:** `X402Gate` — `contracts/X402Gate.sol` (derived from the Aevum
  Starter Kit's `Checkout.sol`, MIT, PQA Labs)
- **Deployed address:** `<PENDING — first deploy on Aevum testnet>`
- **Live demo:** `<PENDING — hosted endpoint / demo video>`

## The problem

APIs that agents call want to be paid per request — but cards, invoices and API
keys are built for humans. A machine buyer needs a payment primitive that is
HTTP-native, settle-able by a third party, and auditable after the fact.
Aevum's flagship feature is exactly this: an x402 facilitator plus a
FiatTokenV2-style stablecoin that supports gasless EIP-3009 transfers.

## How it works — one complete stablecoin payment flow

```
Agent                     Server (resource + relayer)          Aevum testnet
  |  GET /r/<resource>            |                                 |
  | ----------------------------> |                                 |
  |        402 + orderId + nonce  |                                 |
  | <---------------------------- |                                 |
  |  sign ReceiveWithAuthorization|                                 |
  |  GET /r/<resource>            |                                 |
  |  X-PAYMENT: <eip-3009 sig>    |                                 |
  | ----------------------------> | verify sig + nonce off-chain    |
  |                               | settleWithAuthorization ------->|
  |                               | <-------------- Settled event   |
  |          200 + resource +     |                                 |
  |       settlement receipt      |                                 |
  | <---------------------------- |                                 |
  |  GET /receipt/<orderId> ----> | reads receiptOf(orderId)        |
```

1. **Challenge** — server issues a one-shot `orderId` and returns the x402-style
   payment requirements (`scheme: eip3009-gate`, `network: eip155:44005`, asset
   `tUSD8`, amount, `validBefore`).
2. **Sign** — the agent signs `ReceiveWithAuthorization` whose nonce is
   `gate.authorizationNonce(orderId)`, binding the signature to that order.
   No gas required — it is a typed-data signature, not a transaction.
3. **Settle** — the server (relayer) verifies the signature off-chain, then
   submits `X402Gate.settleWithAuthorization`. The gate pulls tUSD8 into itself
   via `receiveWithAuthorization`, records a `Receipt{orderId, payer,
   resourceHash, amount, paidAt}`, forwards the funds to the merchant, and
   emits `Settled`.
4. **Verify** — anyone can independently confirm settlement:
   `receiptOf(orderId)` on-chain, the `Settled` event, or `GET /receipt/<id>`.

## What the contract enforces

- One settlement per `orderId` (`AlreadySettled`)
- The EIP-3009 nonce is derived from `(gate, orderId)` — a signature can't be
  replayed for a different order or contract
- Amount-zero, expiry and used-nonce protection (in tUSD8's EIP-3009)
- `resourceHash` binds each payment to the priced resource served — the
  receipt answers "paid for *what*"
- `spentOf(payer)` + `totalSettled` + `settleCount` — a public cumulative
  ledger for agents and merchants

## Quickstart — local, no testnet funds needed

Requirements: Node 22+, [Foundry](https://getfoundry.sh).

```bash
npm install
node scripts/compile.mjs        # solc-js -> artifacts/

# unit tests (forge)
forge test

# full end-to-end on a local chain
anvil --chain-id 44005 --port 8545 &
node test/e2e.mjs               # deploys MockUSD8+gate, mints, runs agent
```

The e2e exercises the real HTTP flow: 402 challenge → agent signs → server
relays → on-chain settlement → receipt readback.

**Fork of live Aevum (real tUSD8):**

```bash
anvil --fork-url https://rpc-test.qday.info --fork-block-number <latest> \
      --chain-id 44005 --hardfork shanghai --port 8545 &
# fund the agent wallet by impersonating a tUSD8 holder on the fork, then:
node test/e2e-fork.mjs
```

`--hardfork shanghai` is required — Aevum is pre-Cancun, so the forked block
headers carry no blob-gas fields. The fork e2e settles against the real tUSD8
bytecode and its real EIP-712 domain — the same path the live deployment uses.

## Deploy to Aevum testnet

```bash
# 1 tQDAY of gas + a few tUSD8 is enough (Discord #faucet: /faucet <address>)
export RPC_URL=https://rpc-test.qday.info
export DEPLOYER_KEY=0x...        # deployer/merchant wallet
node scripts/deploy.mjs X402Gate 0x456569838f1d43009A91ebA4263147Afd7233483 <merchant>

export GATE_ADDRESS=0x... RELAYER_KEY=0x... TOKEN_ADDRESS=0x456569838f1d43009A91ebA4263147Afd7233483
node src/server.mjs              # serves :4405

# in another shell — the paying agent (needs tUSD8 only)
export AGENT_KEY=0x...
node src/agent.mjs http://localhost:4405 '/r/payment-readiness?url=example.com'
```

## The paid resources

| Route | Price | What it returns |
|---|---|---|
| `GET /r/payment-readiness?url=<target>` | 0.025 tUSD8 | an x402 readiness verdict for `target` (payable / conditional / free / broken + defect codes) — the SolTools audit probe sold per-call |
| `GET /r/chain-stats` | 0.005 tUSD8 | live gate counters (totalSettled, settleCount) |
| `GET /receipt/<orderId>` | free | the on-chain receipt for a settled order |
| `GET /stats` `GET /health` | free | config + counters |

## Payment scheme: `eip3009-gate`

402 response `accepts[0]`:

```json
{
  "scheme": "eip3009-gate",
  "network": "eip155:44005",
  "asset": "0x4565...3483",
  "payGate": "0x<gate>",
  "amount": "25000",
  "orderId": "0x<server-issued>",
  "validBefore": 1733..,
  "resourceHash": "0x<keccak of priced path>"
}
```

Client pays by retrying with `X-PAYMENT: base64({scheme, network, orderId,
payload:{from,value,validAfter,validBefore,nonce,v,r,s}})`. The server answers
200 + `X-PAYMENT-RESPONSE: base64({orderId,txHash,explorer})`.

## Judging-criteria map

| Criterion | Where it's answered |
|---|---|
| UX & onboarding | `agent.mjs` is a 3-line demo; errors are plain JSON (`unknown orderId`, `amount mismatch`, `signature does not recover`) |
| Verifiable on-chain activity | every settle emits `Settled(orderId,payer,resourceHash,amount)` + `receiptOf` view + `/receipt/<id>` + explorer links |
| Documentation | this file + `.env.example` + inline `@dev` notes |
| Agentic mechanics | the buyer is an agent; payment is a signature, no wallet UX |
| Technical quality | EIP-3009 replay binding, checks-effects-interactions, forge tests, e2e on fork-identical chain id |
| Real-world utility | sells a real per-call service (payment-readiness probes) to automated buyers |
| Safety & controls | payer needs no gas (compromised relayer can only relay what's signed); order-bound nonce; expiry; amounts checked server-side |
| Ecosystem contribution | MIT, zero-dependency server, reusable `eip3009-gate` scheme + client pattern |

## Differences from Ethereum that matter here

- Aevum is **Shanghai** — compiled with `evm_version = "shanghai"` / `via_ir`.
- `eth_getLogs` is capped at 1,000 blocks — receipts are read via
  `receiptOf(orderId)` views, not log scans.
- No WebSocket RPC — everything polls over HTTPS.
- Chain id `44005` is baked into the EIP-712 domain — signatures made on a
  local fork (chain id 440050) or anvil (`--chain-id 44005` to match) are not
  valid on real testnet unless the chain id matches.

## Credit

- `contracts/X402Gate.sol` is derived from `Checkout.sol` in the
  [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT,
  PQA Labs): same collect-then-forward shape and order-bound EIP-3009 nonce.
- `contracts/MockUSD8.sol` mirrors the kit's mock (6 decimals, "tUSD8"/"2"
  EIP-712 domain) without external imports.
- Probe verdict taxonomy follows the SolTools x402 readiness audit.

MIT.
