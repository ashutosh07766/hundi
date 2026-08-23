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

See [`docs/rfc.md`](docs/rfc.md) for the mandate model and how this
compares to AP2, ACP, x402, UCP, and Reserve Pay/UAP. See
[`docs/architecture.md`](docs/architecture.md) for the state machines,
the rejection matrix, and the failure-recovery design.

## Quickstart (<10 minutes, no external accounts required)

The default path is fully offline: a deterministic buyer agent, an
Ed25519 signer, and an in-process facilitator with a fake Razorpay client
that runs the *real* facilitator code (verify chain, state machine,
retry/fallback logic) with no network call. No Anthropic key, no passkey
hardware, no Razorpay account needed to see the whole envelope work.

**Prerequisites:** Node 24, pnpm 10+.

```bash
pnpm install

# Six-stage demo: purchase, refusal, human-approval gate, prompt-injection
# caught, failure → retry → fallback-link → stray-capture refunded, revocation.
pnpm --filter @hundi/demo demo

# Batch harness: 20 scripted tasks, each with an expected terminal state,
# generates a results table.
pnpm --filter @hundi/harness harness
```

Everything above runs against an in-memory SQLite database and a scripted
Razorpay double — it exercises the actual facilitator code, not a mock of
it, but it never calls Razorpay's real API.

**To run the real thing** — a live facilitator against Razorpay test mode,
capturing a real test-mode payment — you additionally need a Razorpay test
account:

```bash
cp .env.example .env
# fill in RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
# also set DASHBOARD_TOKEN and ADMIN_TOKEN to any random string — the
# facilitator's boot-time env validation requires both and .env.example
# doesn't list them yet (see packages/facilitator/src/env.ts)

pnpm --filter @hundi/facilitator smoke:settle   # drives one real capture end to end
pnpm --filter @hundi/facilitator serve          # boots the real facilitator on :8790
pnpm --filter @hundi/dashboard dev              # the human console, against the running facilitator
```

The live rail is Razorpay's embedded checkout, driven by Playwright,
routed through the mock-bank ("netbanking") test flow — see
[Payment rail reality](docs/rfc.md#payment-rail-reality) in the RFC for why,
and [`docs/decisions/001-payment-rail.md`](docs/decisions/001-payment-rail.md)
for the raw spike record.

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

**Built and tested** (370 tests, all green, across 34 test files):
facilitator (mandate registration, `/verify`, `/settlements`, approvals,
revoke, admin, webhook, sweep, executor with retry + payment-link fallback
+ anomaly-refund compensator), hash-chained ledger with a `verify-ledger`
CLI, two demo stores (one server-rendered, one CLI-generated static site),
a CLI that retrofits any schema.org store (`npx hundi init`), one
deterministic buyer agent built on a swap-the-brain interface, a six-stage
scripted demo, a 20-task batch harness, a dashboard (mandate ceremony,
pending-approvals with signed decisions, live ledger, revoke), and a real
Razorpay test-mode capture driven through the actual facilitator code
(`pay_TTBO5gj6lma2uw`).

**Not yet built:**
- **The passkey (WebAuthn ES256) ceremony UI.** The server-side
  verification for it is implemented and tested in `packages/core`; no
  browser signs with it yet. Today's "human" signer is a raw Ed25519
  keypair the dashboard holds, disclosed on screen, not a passkey.
- **An LLM-driven buyer agent.** The one agent in this build is a
  deterministic, non-LLM policy — reliable for the demo and the harness,
  but it doesn't demonstrate an actual model making the shopping decision.
  A Claude tool-loop agent behind the same `BuyerTools` interface is
  scoped and pending an API key.
- **The S2S payment rail**, if Razorpay ever grants enablement on it — the
  executor is written against a `SettleDriver` interface specifically so a
  second rail implementation is a swap, not a rewrite.

No secrets are committed to this repository. `.env` is gitignored;
`.env.example` lists the Razorpay credential shape (see the quickstart
above for the two additional local-only tokens it doesn't yet list). Any
key that appears on screen in a recorded demo is treated as burned and
rotated after recording.
