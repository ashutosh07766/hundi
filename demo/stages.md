# The Bar choreography — demo script

Six scripted stages, run against one live facilitator instance
(`pnpm --filter @hundi/demo demo`, or `packages/facilitator/src/serve.ts`
against a real store for a fully live take). Each stage is also an
automated integration test (`demo/src/__tests__/stages.test.ts`) — this
script is the human-facing companion, not a separate source of truth for
what happens.

**Cold open:** don't start at stage 1. Lead with stage 2 (refusal) or stage 5
(the anomaly-refund ledger moment) — whichever plays stronger on the day —
then rewind to the mandate ceremony and play stages in order. Budget below
assumes the rewind structure; total speaking time ≤ 300s.

| Stage | What to show | On-screen ledger line | Spoken narration | Budget |
|---|---|---|---|---|
| 1 — Purchase | Goal → search → cart → verify → settle → captured, dashboard + terminal side by side | `verify_passed`, `attempt_initiated`, `payment_captured` | "Agent picked shoes at ₹3,200. Verify passed: 3,200 ≤ 4,000. Charged." | 45s |
| 2 — Refusal | Same flow, a ₹4,500 cart against the same ₹4,000 ceiling | `verify_rejected { reason: AMOUNT_EXCEEDS_CEILING }` | "The agent cannot exceed the mandate. Not 'won't' — can't." | 30s |
| 3 — Gate | Pending-approval settlement, then a signed approval artifact (not a button click) unblocking it | `approval_requested`, `approval_granted`, `payment_captured` | "Above ₹3,500 blocks until a human signs. Approval is cryptographic, not a button." | 45s |
| 3b — Gate (reject + TTL) | Same setup, human rejects; separately, nobody decides and the sweep abandons it | `approval_rejected` / `approval_expired` | "A human can say no. And if nobody answers, it doesn't wait forever." | 25s |
| 4 — Injection | A poisoned catalog listing, the agent reads it and tries to pay a different merchant | `verify_rejected { reason: MERCHANT_NOT_IN_SCOPE }` | "The catalog told the agent to pay a different merchant. The agent tried. Verify refused — the mandate's merchant allowlist is signed; the agent structurally cannot pay outside it." | 45s |
| 5 — Failure recovery | Three failed attempts, a payment-link fallback, then a late capture on the dead path getting refunded | `payment_failed` x3, `payment_link_issued`, `anomaly_refund_issued`, `payment_captured` | "Payment declined. Retried, then handed the human a link. When the dead path paid late anyway, it was auto-refunded. No retained double-charge." | 50s |
| 6 — Revocation | Revoke mid-session, next purchase attempt refused; prior captured settlement stays captured | `mandate_revoked`, `verify_rejected { reason: MANDATE_REVOKED }` | "Revoke mid-session. The next action is refused. Honest: it doesn't claw back a charge already completed." | 40s |
| Close | `ledger head hash: <hex>` printed on screen | — | "That hash is the external anchor — this recording is the audit trail's witness." | 20s |

Total: 300s.

## Reproducibility

Every stage runs from a clean in-memory db and a freshly registered mandate
(the scripted-issuance ceremony — see `agents/scripted-brain/src/session.ts`).
Nothing in a stage depends on wall-clock time except stage 3's TTL sub-run,
which drives a fake clock rather than waiting out a real 30-minute window —
run it twice in a row from a clean db and it reproduces identically both
times.
