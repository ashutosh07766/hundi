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
