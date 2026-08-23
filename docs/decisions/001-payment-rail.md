# Decision 001 — Payment rail (Day 1 spike, 2026-08-23)

## Verdicts (live against test account rzp_test_TT9x...)

| Probe | Result |
|---|---|
| Rail (a) S2S JSON `POST /v1/payments/create/json` | **DEAD**: `BAD_REQUEST_ERROR — The requested URL was not found on the server`. Endpoint not exposed on a fresh self-serve test account; enablement-gated. Order creation itself works fine. |
| Orders `receipt` uniqueness | **REFUTED** (docs say enforced-unique): two orders with identical receipt both accepted (`order_TTA3MqPUu1fcYu`, `order_TTA3N2YobvuyXZ`). Receipt is a reconciliation lookup key only — NOT a dedup guard. |
| Payment Link `reference_id` uniqueness | **CONFIRMED live**: duplicate rejected with explicit error. |
| Webhook delivery via cloudflared tunnel | Configured; listener HMAC-verifies. |

## Decision

**Rail (b): embedded checkout.js + Playwright driver** executes payments (agent-side deterministic driver behind /settle). Payment Links remain the human-fallback path. Rail (a) revisited only if Razorpay support grants S2S enablement (request filed).

## Consequences

- Our idempotency-key store is the ONLY order-create dedup guard (provider gives none). Strengthens the product thesis; raises the bar on our own implementation (KTD5).
- `packages/checkout-driver` is real scope (not dead code): budget it.
- Reconciliation queries Razorpay by receipt for lookup, never relies on receipt for dedup.

## Update (2026-08-23, later) — rail (b) driven flow settled

Live spike drove all three sub-rails; only ONE works hands-free under automation:
- **Cards**: DEAD under automation. Stripe test card BIN-flagged international; Razorpay's real domestic test card submits but the OTP step hangs forever — Sardine.ai fingerprinting (`enablePortScanning`), Radar/hCaptcha/HumanSecurity, PerimeterX EvalError. A client-side risk gate that never resolves for a bot.
- **UPI**: not offered on this test account at all.
- **Netbanking**: WORKS. Selecting a bank opens Razorpay's own `mocksharp` mock-bank popup with plain Success/Failure buttons — no OTP, no fraud scoring. This is the driven flow.

**Failure injection** = click the mock-bank **Failure** button (deterministic; replaces `failure@razorpay`).
**Numbers:** capture ×2 (pay_TTAqj6..., pay_TTArGp...), 5/5 repeat (20.9–24.8s each), signatures verified. Per-settle budget ~25s → harness batch-of-20 ≈ 8 min (within gate). Executor (U7) drives netbanking; UPI functions kept exported for a future swap if UPI gets enabled for the demo narrative.
