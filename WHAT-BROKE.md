# WHAT BROKE

Running log of every real breakage and its fix. Newest first.

## 2026-08-23 — Day 1 spike: two assumptions died in contact with reality
1. The S2S JSON create-payment endpoint (the one Razorpay's own MCP server wraps) returned "URL not found" on a fresh test account — it's enablement-gated. Re-architected same hour to the embedded-checkout Playwright driver per the pre-agreed decision rule.
2. Razorpay docs say Orders `receipt` is enforced-unique. It is not — two identical-receipt orders were accepted. Our facilitator's own idempotency store is now the sole dedup guard on order creation. The trust envelope has to bring its own guarantees; the rail provides fewer than documented.
