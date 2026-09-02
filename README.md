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
- **Goal-locked mandates.** Optional goal_keywords bind a mandate to a
  purpose; an off-goal item is rejected GOAL_MISMATCH.
- **Human-in-the-loop approvals.** Anything over the threshold parks as
  pending_approval and waits for a human-signed decision in the dashboard.
- **Idempotency + graceful failure.** Retries replay instead of
  double-charging; failed captures fall back to a payment link, and a
  late stray capture is auto-refunded.
- **Tamper-evident audit.** Every decision is one row in a hash-chained,
  append-only ledger, verifiable from genesis with one command.
- **Agent-native by an MCP server.** Claude (or any MCP client) shops
  through tools that expose no payment capability at all — only
  browse/search/propose-mandate/request-purchase/read-orders.

See [`docs/rfc.md`](docs/rfc.md) for the mandate model and how this
compares to AP2, ACP, x402, UCP, and Reserve Pay/UAP. See
[`docs/architecture.md`](docs/architecture.md) for the state machines,
the rejection matrix, and the failure-recovery design.

## Quickstart (judge-runnable in 2 minutes)

Two paths. The **offline path** needs no accounts and proves the whole
envelope. The **live hero path** drives Claude Desktop against a real
Razorpay TEST-mode capture.

**Prerequisites:** Node 24, pnpm 10+. `pnpm install` once.

### Path 1 - offline, no accounts (fastest)

```bash
pnpm install
# Six-stage demo: purchase, refusal, human gate, prompt-injection caught,
# failure -> retry -> fallback-link -> stray-capture refunded, revocation.
pnpm --filter @hundi/demo demo
```

Runs the real facilitator code (verify gate, state machine, ledger)
against an in-memory SQLite DB and a scripted Razorpay double - no
network call, no keys.

### Path 2 - live hero flow (Claude Desktop -> real TEST-mode capture)

This is the demo in [`demo/recording-script.md`](demo/recording-script.md).
It captures a **real Razorpay TEST-mode payment** (rzp_test_...). No live
money is ever moved; the facilitator refuses anything but test keys.

1. **Configure secrets** (one-time):

   ```bash
   cp .env.example .env
   # Fill RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
   # (test mode), and DASHBOARD_TOKEN / ADMIN_TOKEN to any strong random
   # strings. Optionally set ONBOARD_TOKEN to let the agent scan a store.
   ```

2. **Boot the facilitator** (the only process that holds Razorpay keys;
   binds 127.0.0.1:8790, reads ../../.env):

   ```bash
   pnpm --filter @hundi/facilitator serve
   ```

   If the checkout driver reports a missing browser on first capture,
   install Playwright's Chromium once: `pnpm --filter @hundi/facilitator exec playwright install chromium`.

3. **Boot the dashboard** (the human console, Vite on :5173):

   ```bash
   pnpm --filter @hundi/dashboard dev
   ```

   Open http://localhost:5173 and paste your DASHBOARD_TOKEN (same value
   as .env) into the dashboard's settings field.

4. **Build the MCP server** and point Claude Desktop at the built entry:

   ```bash
   pnpm --filter @hundi/mcp-server build   # -> packages/mcp-server/dist/index.js
   ```

   Add to Claude Desktop's config
   (`~/Library/Application Support/Claude/claude_desktop_config.json` on
   macOS), using the **absolute** path to this repo:

   ```json
   {
     "mcpServers": {
       "hundi": {
         "command": "node",
         "args": ["/ABSOLUTE/PATH/TO/hundi/packages/mcp-server/dist/index.js"],
         "env": {
           "HUNDI_FACILITATOR_URL": "http://127.0.0.1:8790"
         }
       }
     }
   }
   ```

   `HUNDI_FACILITATOR_URL` defaults to `http://127.0.0.1:8790` if omitted.
   Set `HUNDI_ONBOARD_TOKEN` to your `.env` `ONBOARD_TOKEN` only if you
   want the agent to onboard stores itself. Restart Claude Desktop; the
   `hundi` server should show connected.

5. **Run the hero flow in Claude Desktop.** In the dashboard Stores tab,
   confirm `myfrido-com` is onboarded (if not, ask the agent to
   `onboard_store` `https://myfrido.com`). Then, in Claude Desktop:

   - "What's your Hundi shopping identity, and what can you spend?"
     -> `get_agent_identity`
   - "Propose a mandate for myfrido-com: a Rs 5,000 budget to shop Frido,
     hands-free." -> `prepare_mandate` returns a one-tap approve link
   - Open the link, tap **Approve** in the dashboard (human signature).
   - "Buy me the Frido leather sneakers, size 11UK." -> `search_products`
     then `request_purchase` -> captured with a real Razorpay `payment_id`.
   - "What have you bought me?" -> `list_orders`.

6. **Verify the audit trail:**

   ```bash
   pnpm --filter @hundi/facilitator verify-ledger hundi.db
   ```

The full shot-by-shot narration is in
[`demo/recording-script.md`](demo/recording-script.md); the 60-90s trust
reel is in [`demo/trust-demo-choreography.md`](demo/trust-demo-choreography.md).

> **Note for judges:** everything runs in Razorpay TEST MODE only - real
> orders are never placed at the merchant, and only test-mode payments are
> captured. Any GitHub-account / push caveat you may see elsewhere is a
> maintainer workflow detail and is not relevant to running or judging this.

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
