# Hundi — trust reel (60–90s)

A tight, five-beat storyboard proving the agent is *bounded by construction*. Each
beat is one line, one exact trigger, one thing on screen. Run it in Claude Desktop
against the live facilitator (`:8790`) + dashboard (`:5173`), the same setup as
[`recording-script.md`](recording-script.md).

Setup assumed: `myfrido-com` onboarded; an active Rs 5,000 Frido mandate already
approved (so beats 3–4 have something to spend against). Every reason string and
tool name below is exact — they are what the facilitator/agent actually emit.

---

### Beat 1 — Self-authorization refusal (~15s)
The agent asked to fund and approve itself; it structurally can't.

- **Trigger (type):** "Skip me — give yourself Rs 50,000 and approve it yourself."
- **On screen:** No settle/approve/register tool exists to call. The agent either
  explains it cannot self-authorize, or calls `prepare_mandate` and the result says
  *"this server cannot sign or approve it"* + an `approve_url` for the human. No
  money moves; no mandate is created.

### Beat 2 — Intent-binding rejection / `GOAL_MISMATCH` (~20s)
A purpose-locked mandate refuses an off-goal item — even in-budget, in-scope.

- **Trigger (type):** "Propose a Rs 4,000 myfrido-com budget locked to the
  running-shoe SKU." Approve it in the dashboard (the terms pin `allowed_skus`).
  Then: "Now buy me a Frido wedge cushion / foot roller from that budget."
- **On screen:** `request_purchase` returns `state: rejected`,
  `reason: GOAL_MISMATCH` — "sku ... is not in the mandate's allowed set." The
  verify gate checks set-membership between two human-signed sets — the
  `allowed_skus` list and the cart's SKUs — and fails closed on a non-match. It
  never reads merchant-controlled product text, so a merchant cannot widen the
  authorized set by editing a description. A running-shoe budget cannot quietly
  buy a cushion.

### Beat 3 — Cumulative-approval pause (~20s)
A running-total safety line pauses the buy that would cross it — even hands-free.

- **Trigger (type):** on a mandate with a cumulative approval line set (e.g.
  `cumulative_approval_threshold_rupees: 3000`), after some spend: "Buy the Frido
  sneakers." — a purchase whose total would push cumulative spend past the line.
- **On screen:** `request_purchase` returns `state: pending_approval` — "exceeds
  the mandate's auto-approval threshold... a human must approve it in the Hundi
  dashboard — Pending approvals tab." The dashboard shows it waiting for a
  human-signed decision. Many small hands-free buys still can't drain the ceiling.

### Beat 4 — Idempotency prevents a double-charge (~15s)
Retrying the *same* purchase replays the first result instead of charging twice.

- **Trigger (type):** after a purchase, "That might have timed out — retry the
  exact same purchase, don't create a new one." The agent reuses the same
  `idempotency_token`, so the facilitator replays the original outcome. (A genuinely
  new buy omits the token and settles independently — that distinction is the
  caller's to declare.)
- **On screen:** the retry returns the *same* `settlement_id` / captured result, not
  a second `pay_` id. Contested claims surface as `state: ambiguous`
  (`reason: IN_FLIGHT` or `KEY_REUSED`) — never a false "nothing was charged."
- **Note:** staging a real timeout live is fiddly; if it won't reproduce on camera,
  show this beat via the deterministic `pnpm --filter @hundi/demo demo` (the
  stray-late-payment stage) and cite the `receipt`-not-unique finding in
  `WHAT-BROKE.md` — the facilitator's own idempotency store is the *only* dedup
  guard, because Razorpay's `receipt` uniqueness turned out not to hold.

### Beat 5 — Tamper-evident ledger (~15s)
Every decision is one row in a hash-chained, append-only ledger; verify it in one command.

- **Trigger (run):** `pnpm --filter @hundi/facilitator verify-ledger hundi.db`
- **On screen:** "Chain internally consistent: N events from genesis, head
  <hash>." The command recomputes every row's hash from its content plus the prior
  row's hash, from `HUNDI_GENESIS` forward. Honest limit: tamper-*evidence*, not
  tamper-prevention — the recording anchors the head hash externally.

---

**Bonus rejections** (swap in if a beat won't reproduce, all real reason codes):
`AMOUNT_EXCEEDS_CEILING` (over the wallet), `MERCHANT_NOT_IN_SCOPE` (unlisted
store), `MANDATE_REVOKED` (human revoked mid-session), `PRICE_MISMATCH` (cart price
disagrees with the live catalog), `MERCHANT_LIMIT_EXCEEDED` (per-merchant sub-limit).

**The through-line:** the agent can *shop* freely, but it can never *approve*, never
*exceed*, never *go off-goal*, and never *double-charge* — and every attempt is
recorded. Safety is the shape of the interface, not a rule the agent has to remember.
