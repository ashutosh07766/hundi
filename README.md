# hundi

An open trust envelope for AI-agent-initiated payments on Razorpay (test
mode): a human signs a scoped spending mandate, any buyer agent can
assemble a cart, and a facilitator — the only process holding Razorpay
keys — decides whether it settles. The agent never has a settle
capability to misuse in the first place; that's enforced by the shape of
the interface it's built on, not by a rule it has to remember.

Built for Razorpay's AI Buildathon, Track 01: *"Every money action
explainable, bounded and gated. Show the audit trail and one failure
handled gracefully."*

## What it does

- **Human-signed spending mandates.** A human authorizes a scoped budget
  once (store, ceiling, expiry). The agent holds a distinct key that can
  sign carts but can never approve, revoke, or self-fund.
- **A deterministic verify gate.** Every purchase clears the same checks
  before money moves: signature, catalog price-match, ceiling, merchant
  scope, expiry, revocation. Failures return an exact reason
  (AMOUNT_EXCEEDS_CEILING, MERCHANT_NOT_IN_SCOPE, PRICE_MISMATCH, ...).
- **Bounded hands-free spend.** Per-purchase and cumulative approval lines,
  plus per-merchant sub-limits, so many small auto-buys still can't drain
  the ceiling.
- **Purpose-locked mandates.** An optional signed `allowed_skus` set pins a
  mandate to specific items; a cart with any off-list SKU is rejected
  GOAL_MISMATCH. The check is set-membership between two human-signed sets —
  never a keyword match against merchant-controlled product text — so the
  merchant can't widen the authorization and the agent can't buy off-list.
- **Human-in-the-loop approvals.** Anything over the threshold parks as
  pending_approval and waits for a human-signed decision in the dashboard.
- **Human-only refunds.** A human reverses a capture from the dashboard (a
  real test-mode refund, recorded in the ledger). There is no refund tool on
  the agent's interface — it cannot undo or mask its own spend.
- **Idempotency + graceful failure.** Retries replay instead of
  double-charging; failed captures fall back to a payment link, and a
  late stray capture is auto-refunded.
- **Tamper-evident audit.** Every decision is one row in a hash-chained,
  append-only ledger, verifiable from genesis with one command.
- **Agent-native by an MCP server.** Claude (or any MCP client) shops
  through tools that expose no payment capability at all — only
  browse, cross-store search, propose-mandate, request-purchase, and
  read/explain-orders. There is no approve, settle, or refund tool to misuse.

See [`docs/rfc.md`](docs/rfc.md) for the mandate model and how this
compares to AP2, ACP, x402, UCP, and Reserve Pay/UAP. See
[`docs/architecture.md`](docs/architecture.md) for the state machines,
the rejection matrix, and the failure-recovery design.

## Running it locally

**Prerequisites:** Node 24, pnpm 10+.

```bash
pnpm install
```

### End to end, offline (no accounts, no keys)

```bash
# Exercises the real facilitator code — verify gate, state machine, ledger,
# retry/fallback — against an in-memory SQLite DB and a scripted Razorpay double.
pnpm --filter @hundi/demo demo

# 20-task batch run, each task declaring its expected terminal state up front.
pnpm --filter @hundi/harness harness
```

No network call and no credentials are involved — this runs the actual
facilitator, not a mock of it.

### Against Razorpay test mode

The facilitator is the only process that holds Razorpay keys; the dashboard is
the human console for approvals, revocations, and refunds.

```bash
cp .env.example .env
# Fill RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET (test
# mode) and set DASHBOARD_TOKEN / ADMIN_TOKEN to any strong random strings.

pnpm --filter @hundi/facilitator serve     # 127.0.0.1:8790
pnpm --filter @hundi/dashboard dev         # http://localhost:5173
```

Buyer agents connect through the MCP server, which exposes only shopping
tools — browse, cross-store search, propose-mandate, request-purchase,
read/explain-orders — and no payment capability. Build it and point any MCP
client at the entry:

```bash
pnpm --filter @hundi/mcp-server build      # -> packages/mcp-server/dist/index.js
```

```json
{
  "mcpServers": {
    "hundi": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/hundi/packages/mcp-server/dist/index.js"],
      "env": { "HUNDI_FACILITATOR_URL": "http://127.0.0.1:8790" }
    }
  }
}
```

The live rail is Razorpay's embedded checkout, driven by Playwright through the
mock-bank ("netbanking") test flow — see
[Payment rail reality](docs/rfc.md#payment-rail-reality) in the RFC for why, and
[`docs/decisions/001-payment-rail.md`](docs/decisions/001-payment-rail.md) for
the raw spike record. If the checkout driver reports a missing browser on first
capture, run `pnpm --filter @hundi/facilitator exec playwright install chromium`
once.

Everything runs in Razorpay **test mode** only — the facilitator refuses to boot
with anything but `rzp_test_` keys, and no real order is placed at the merchant.

## Verifying the audit trail

```bash
pnpm --filter @hundi/facilitator verify-ledger <path-to-db>
```

Walks the hash-chained ledger from genesis and confirms every row's hash
matches what's recomputed from its own content plus the previous row's
hash — the mechanism `docs/architecture.md` and the RFC's honest-limits
section describe.

## Results

Batch harness, 20 scripted tasks, each declaring its own expected terminal
state (the oracle) before running — see
[`docs/results.md`](docs/results.md) / [`docs/results.json`](docs/results.json)
for the full per-task table.

| | |
|---|---|
| Tasks | 20 |
| Matched oracle | 20 (100%) |
| Buckets | settled: 8 · rejected: 3 · HITL-approved: 3 · HITL-rejected: 2 · recovered: 1 · settled-on-retry: 1 · blocked (injection): 2 |
| Wall clock | ~2.8s |

This run is measured against the same in-process facilitator + fake
Razorpay double the demo uses (see `packages/harness/src/setup.ts`) — no
network flake, so any mismatch here would be a real facilitator bug, not
noise. The live rail is proven separately: a real test-mode capture,
`pay_TTBO5gj6lma2uw`, driven end to end through the actual facilitator
code (`smoke:settle`, not the spike scripts) — see `WHAT-BROKE.md`.

## Architecture, in one paragraph

The facilitator is the only process that ever holds Razorpay credentials.
Buyer agents talk to two endpoints — submit a mandate-signed cart, poll
for the result — and nothing else; there is no agent-facing settle
endpoint anywhere in the API surface. Every settlement is a row in a
DB-enforced state machine (compare-and-swap transitions, partial unique
indexes preventing two captured attempts for one settlement); a
reconciliation sweep is the sole owner of every timeout, and a hash-chained
ledger records every decision, human or facilitator, in one append-only
sequence. Full detail, including the mermaid state diagrams and the
`/verify` rejection matrix, is in [`docs/architecture.md`](docs/architecture.md).

## What broke

Full log: [`WHAT-BROKE.md`](WHAT-BROKE.md). The two entries that shaped the
build most:

1. **The S2S payment API Razorpay's own MCP server calls is
   enablement-gated in practice**, not self-serve as documented — a fresh
   test account got "URL not found." The build re-architected the same
   hour to drive Razorpay's embedded checkout with browser automation
   instead, and only one payment method (netbanking, via Razorpay's own
   mock-bank test popup) turned out to clear hands-free under automation.
2. **Razorpay's docs claim Orders' `receipt` field is enforced-unique. It
   isn't** — two orders with an identical receipt were both accepted live.
   The facilitator's own idempotency-key store and mandate-hash uniqueness
   check turned out to be the *only* dedup guard on order creation, not a
   defense-in-depth layer on top of one the rail already provided. The
   trust envelope had to bring its own guarantees; the rail gave fewer
   than its documentation promised.

## Status

**Built and tested** (663 tests, all green, across 63 test files):
facilitator (mandate registration, `/verify`, `/settlements`, approvals,
revoke, human-issued refunds, admin, webhook, sweep, executor with retry +
payment-link fallback + anomaly-refund compensator), the cumulative-wallet
model with per-merchant sub-limits, cumulative approval lines, and signed
`allowed_skus` purpose-locking, a hash-chained ledger with a `verify-ledger`
CLI, an MCP server (11 shopping tools, no payment capability), two demo
stores (one server-rendered, one CLI-generated static site), a CLI that
retrofits any schema.org store (`npx hundi init`), buyer agents on a
swap-the-brain interface (a deterministic policy plus an LLM tool-loop), a
six-stage scripted demo, a 20-task batch harness, a dashboard (mandate
ceremony, pending-approvals with signed decisions, live ledger, revoke,
refund), and a real Razorpay test-mode capture driven through the actual
facilitator code (`pay_TTBO5gj6lma2uw`).

**Not yet built:**
- **The passkey (WebAuthn ES256) ceremony UI.** The server-side
  verification for it is implemented and tested in `packages/core`; no
  browser signs with it yet. Today's "human" signer is a raw Ed25519
  keypair the dashboard holds, disclosed on screen, not a passkey.
- **Real merchant order placement.** A capture is a real test-mode payment,
  but no order is created at the merchant — that's an honest test-mode gap.
  The executor is written against a `SettleDriver` interface so a fulfilment
  step is an addition, not a rewrite.
- **The S2S payment rail**, if Razorpay ever grants enablement on it — the
  same `SettleDriver` seam makes a second rail a swap, not a rewrite.

No secrets are committed to this repository. `.env` is gitignored and
`.env.example` documents every variable the facilitator needs. Any
key that appears on screen in a recorded demo is treated as burned and
rotated after recording.
