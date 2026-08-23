# RFC: a trust envelope for AI-agent-initiated payments

## Problem

An AI agent that can browse a catalog and call a checkout API can also be
tricked, over-reach, or simply bugged into spending money it was never
authorized to spend. The consensus answer forming across the industry (AP2,
ACP, x402, UCP) is the same shape every time: a human issues a scoped,
signed, non-reusable spending credential, and a piece of software that is
*not* the agent — a facilitator — verifies that credential deterministically
before any money moves. Hundi implements that shape over Razorpay/UPI-fiat
rails: a human signs a spending mandate, any buyer agent can assemble a
cart, and the facilitator's `/verify` gate is the only thing that decides
whether a purchase is allowed to settle.

Razorpay's own MCP server is the concrete instance of the gap this closes:
it exposes `create_order → initiate_payment → submit_otp` straight to an
LLM tool loop, with the API keys living in the same process as the model
and no deterministic policy check between the two (read from its public Go
source). Hundi is the policy layer that belongs between an agent's judgment
and a merchant's money — a complement to that server, not a criticism of it.

## The mandate model

Two signed documents, chained by hash:

- **IntentMandate** — issued once, by the human, through a registered
  ceremony: `goal` (free text, advisory only), `ceiling_paise`,
  `approval_threshold_paise`, `currency` (pinned `INR`), `merchants[]`
  (a signed allowlist), `expiry`, `agent_pubkey`, and a per-mandate nonce.
  Signed by the human's registered credential.
- **CartMandate** — built by the agent at purchase time: `merchant_id`,
  line items, `total_paise`, and `intent_hash` linking it to exactly one
  IntentMandate. Signed by the *agent's own key*, not the human's — see
  "Deliberate divergences" below.

A mandate is only valid if it was **registered** with the facilitator
through a ceremony gated by a server-issued, single-use token that only a
human dashboard session can mint. `/verify` resolves the signing key from
that registry, never from the request payload — otherwise any agent could
mint itself a mandate with its own key and pass every check. An
unregistered chain is rejected as `MANDATE_UNKNOWN`; a bare registration
call without a ceremony token is rejected outright. Human approvals on
above-threshold settlements go through the same registered-credential
machinery: an approval is `{settlement_id, mandate_cart_hash, decision}`
signed and verified the same way a mandate is, so the human's sign-off is a
cryptographic artifact, not a button click an unauthenticated caller could
also produce.

**Signature envelope.** The verifier (`packages/core`) supports two
signature types behind one interface: `ed25519` and `webauthn-es256`. Both
are implemented and unit-tested, including the ES256 path's exact WebAuthn
shape — verifying over `authenticatorData || SHA-256(clientDataJSON)`
against a P-256 JWK, matching how a platform passkey actually signs.
**What's wired end-to-end today is the Ed25519 path only**: the dashboard
holds a raw Ed25519 keypair standing in for "the human," and every agent
identity in the demo is its own Ed25519 keypair. The passkey ceremony UI
(the browser-side `navigator.credentials` flow) is not built — the
verification math it would call already exists and is tested, but nothing
in the dashboard invokes it yet. This is disclosed, not hidden: a demo run
that shows a raw-keypair "human" signer is not simulating anything the
server-side gate doesn't actually enforce.

## Diff table

| | AP2 v0.2 | ACP (2026-04-17) | x402 | UCP | Reserve Pay / UAP | **Hundi** |
|---|---|---|---|---|---|---|
| Governance | FIDO Alliance (donated Apr 2026) | OpenAI/agentic-commerce ecosystem | Linux Foundation (`x402-foundation/x402`) | Shopify | Razorpay × NPCI | this repo |
| Credential shape | two SD-JWT mandates (Checkout, Payment; open/closed variants), linked by `checkout_hash` | allowance object (`reason: one_time`, `max_amount`, `currency`, `merchant_id`, `expires_at`, `checkout_session_id`) | none — a 402 challenge/response per request | checkout state object, no mandate concept | per-merchant spending cap set at enrollment, revocable | two hash-linked mandates (Intent, Cart), Ed25519 today / ES256 verified-but-unwired |
| Who signs the cart | the **merchant** attests contents/price | n/a (allowance, not a cart signature) | n/a | n/a | n/a | the **agent**, cross-checked against the facilitator's own merchant-price registry |
| Idempotency | — | native `Idempotency-Key` header | — | — | — | caller `Idempotency-Key` header **and** our own `mandate_cart_hash` business-uniqueness check — Razorpay's own rail gave us neither |
| Settlement split | — | — | `/verify` + `/settle`, crypto-rails only | `requires_escalation` → `continue_url` handoff | rail-level cap enforcement, no public API | `/verify` (stateless dry-run) + facilitator-internal settle; no agent-facing settle endpoint exists at all |
| Signature scheme | ES256 (passkey-native) | n/a | wallet signature | n/a | UPI PIN / AFA | ES256 verifier built + tested; Ed25519 is what's actually signing in this build |
| Rail | any (protocol-level) | any | crypto only | any | UPI, live | Razorpay test mode, fiat |
| Status | spec, FIDO-governed | spec | spec + reference implementation | shipped at Shopify | Reserve Pay: live pilot (Zomato/Swiggy/Zepto, Feb 2026). UAP: not public, pending RBI approval | working code, this repo, test mode |

**Deliberate divergence — who signs the cart.** AP2's Cart/Payment mandate
is merchant-signed: the merchant attests to the contents and price, so a
forged cart is caught by a broken merchant signature. Hundi's CartMandate
is signed by the *agent*, with the facilitator cross-checking each line
item's price against a merchant-scoped catalog-price registry
(`PRICE_MISMATCH`) instead of requiring a merchant-side signing
integration. The reason is practical: Hundi retrofits *any* schema.org
storefront via a CLI scanner, with no merchant onboarding flow to collect a
signing key from. The tradeoff is real — Hundi's price check trusts
whatever price the CLI last scanned into the registry, where AP2's
merchant signature is contemporaneous with the actual sale. This is scoped
honestly, not hidden.

**x402's shape, reimplemented over fiat.** x402's `/verify` + `/settle`
split is the closest structural analogue to Hundi's own `/verify` +
facilitator-internal-settle split — Hundi borrows the shape and reimplements
it for a rail x402 doesn't touch (crypto only, per its own spec).

**UCP's vocabulary, borrowed verbatim.** `requires_escalation` and
`continue_url` describe exactly the pending-approval → human-decision →
resume shape Hundi's `pending_approval` state and `/approvals` endpoint
implement; cited because the terms are apt, not because Hundi integrates
with UCP.

**Reserve Pay / UAP — pattern-compatible, not integrated.** Reserve Pay is
a real, live pilot proving that a per-merchant, revocable, no-repeated-PIN
consent shape works at the rail level in India today. UAP is NPCI's
pre-launch generalization of that shape, not yet public and pending RBI
approval. Hundi does not integrate with either — it proves the same
consent *pattern* is buildable as an open software layer on public
Razorpay primitives, ahead of a rail-native version arriving.

## Honest limits

- **Tamper-evidence, not tamper-prevention.** The ledger is an
  append-only, hash-chained sequence (`prev_hash`/`row_hash` per event);
  `verify-ledger` walks and recomputes the chain, and app-level triggers
  block `UPDATE`/`DELETE` through the running process. None of that stops
  the database owner from rewriting the whole SQLite file from genesis with
  direct file access — the internal-consistency proof needs an external
  anchor (e.g. publishing the head hash somewhere outside the DB owner's
  control) to close that gap. `verify-ledger`'s own output says this in
  plain language.
- **Mandate bundles are bearer artifacts.** Whoever holds a valid signed
  mandate chain can present it. Replay is bounded, not eliminated: the
  allowance behind an IntentMandate is single-use, so a replayed bundle can
  execute the human's own already-authorized purchase at most once, never
  mint additional spend.
- **Within-mandate misuse is ceiling-bounded by design, not
  item-bounded.** `goal` is free text the agent's own search logic reads —
  it is advisory, never enforced server-side. Deterministic enforcement
  covers amount, merchant, currency, expiry, and (via the catalog-price
  cross-check) unit price — not "is this the right *kind* of thing to buy."
  Worst case under a fooled or careless agent is one purchase, up to the
  mandate ceiling. A merchant or human who wants item-level control sets
  `approval_threshold_paise = 0`, which forces every purchase through the
  signed human-approval gate regardless of amount.
- **No rate limiting yet.** Abuse is bounded by the single-use allowance
  model (one IntentMandate → at most one captured purchase), not by a
  request-rate guard. A missing rate limit doesn't currently translate into
  unbounded spend, but it is not defended in depth.
- **Passkey ceremony is future work.** See "Signature envelope" above —
  the verification path is real and tested; the browser ceremony that would
  produce a passkey-signed mandate is not built.

## Payment rail reality

Two Day-1 assumptions from Razorpay's own documentation did not survive
contact with a live test account, and both changed the design:

1. **The self-serve S2S JSON create-payment endpoint — the one Razorpay's
   own MCP server calls internally — is enablement-gated in practice.** A
   fresh test account got `BAD_REQUEST_ERROR — The requested URL was not
   found on the server`. The build pivoted the same day to driving
   Razorpay's embedded checkout with browser automation instead. Of the
   payment methods available on the checkout page, only **netbanking**
   clears hands-free under automation: selecting a bank opens Razorpay's
   own `mocksharp` mock-bank popup with plain Success/Failure buttons, no
   OTP, no fraud scoring. Card automation is blocked by bot-detection and
   fraud tooling that never resolves for a scripted client (fingerprinting,
   CAPTCHA/human-verification challenges), and UPI was not offered at all
   on the account used. Failure injection on this rail means clicking the
   mock-bank's own Failure button.
2. **Razorpay's docs describe Orders' `receipt` field as enforced-unique.
   It measurably is not** — two orders created with an identical `receipt`
   were both accepted live. The rail provides no create-time dedup
   guarantee at all. Hundi's own idempotency-key store (on `POST
   /settlements`) and its `mandate_cart_hash` business-uniqueness check are
   therefore the *only* guards against a duplicate settlement or duplicate
   order create — not a fallback layered on top of a provider guarantee,
   the sole guard.

A related correction on the refund side: the plain Razorpay Payments
Refund API used by the anomaly compensator carries no `Idempotency-Key`
header (that header exists only for RazorpayX payouts/refunds, a separate
product). The compensator's protection against double-refunding a stray
capture is therefore Hundi's own ledger check — one `anomaly_refund_issued`
event per settlement-and-payment pair — not a provider-side guarantee.

Both corrections point the same direction: wherever the rail's documented
guarantee turned out to be narrower than advertised, the facilitator's own
state and ledger became the actual guard. That is the product thesis
holding up under its own build, not just an argument for it.
