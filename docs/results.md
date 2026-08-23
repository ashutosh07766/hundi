# Batch harness results

Measured on the deterministic scripted settlement driver (see packages/harness/src/setup.ts) — the live Razorpay test-mode rail is proven separately (pay_TTBO5gj6lma2uw, docs/decisions/001-payment-rail.md, 5/5 repeat). Because this driver has no network or browser flake, the expected match rate is 20/20 = 100%: any mismatch below is a real bug in the facilitator, not tolerated as noise.

## Results

| task id | kind | expected | actual | bucket | pass |
|---|---|---|---|---|---|
| happy-1 | happy | captured | captured | settled | ✅ |
| happy-2 | happy | captured | captured | settled | ✅ |
| happy-3 | happy | captured | captured | settled | ✅ |
| happy-4 | happy | captured | captured | settled | ✅ |
| happy-5 | happy | captured | captured | settled | ✅ |
| happy-6 | happy | captured | captured | settled | ✅ |
| happy-7 | happy | captured | captured | settled | ✅ |
| happy-8 | happy | captured | captured | settled | ✅ |
| over-cap-1 | over-cap | blocked-verify (AMOUNT_EXCEEDS_CEILING) | blocked-verify (AMOUNT_EXCEEDS_CEILING) | rejected | ✅ |
| over-cap-2 | over-cap | blocked-verify (AMOUNT_EXCEEDS_CEILING) | blocked-verify (AMOUNT_EXCEEDS_CEILING) | rejected | ✅ |
| over-cap-3 | over-cap | blocked-verify (AMOUNT_EXCEEDS_CEILING) | blocked-verify (AMOUNT_EXCEEDS_CEILING) | rejected | ✅ |
| auto-approve-1 | auto-approve | captured | captured | HITL-approved | ✅ |
| auto-approve-2 | auto-approve | captured | captured | HITL-approved | ✅ |
| auto-approve-3 | auto-approve | captured | captured | HITL-approved | ✅ |
| auto-reject-1 | auto-reject | rejected | rejected (approval_rejected) | HITL-rejected | ✅ |
| auto-reject-2 | auto-reject | rejected | rejected (approval_rejected) | HITL-rejected | ✅ |
| fail-all-1 | fail-all | settling | settling | recovered | ✅ |
| fail-then-capture-1 | fail-then-capture | captured | captured | settled-on-retry | ✅ |
| injection-1 | injection | blocked-verify (MERCHANT_NOT_IN_SCOPE) | blocked-verify (MERCHANT_NOT_IN_SCOPE) | blocked | ✅ |
| injection-2 | injection | blocked-verify (MERCHANT_NOT_IN_SCOPE) | blocked-verify (MERCHANT_NOT_IN_SCOPE) | blocked | ✅ |

## Summary

- Tasks: 20
- Matched oracle: 20 (100.0%)
- Mismatches: 0
- Bucket counts: {"settled":8,"rejected":3,"HITL-approved":3,"HITL-rejected":2,"recovered":1,"settled-on-retry":1,"blocked":2}
- Wall clock: 2408ms
- Ledger head hash: `cb9e6ca273df86079db8081680f65dad60d186aa1076a47a8b154fdf72679c22`

