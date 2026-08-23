# Hundi — 5-minute pitch video script

**Goal of this script:** surface the *depth* (architecture, the adversarial-review catch, measured numbers), not just the surface UI. Judges for Track 01 reward "would you trust it" and "what broke" — this script leads with both.

**Recording setup:** screen recording + your voice. Have these ready in tabs/windows:
1. The store — `localhost:8791` (looks like a real shop)
2. The dashboard — `localhost:5173` (Live ledger tab ready)
3. A terminal in `~/hundi`
4. `docs/how-it-works.html` open (for the architecture beat)

Rotate your Razorpay keys after recording (see README) — they may flash on screen.

---

## The script (≈5:00)

### [0:00–0:25] Cold open — lead with the strongest moment

**SHOW:** the dashboard, click "Run scam test" on a mandate → it shows `✗ blocked: MERCHANT_NOT_IN_SCOPE`.

**SAY:**
> "Watch this. An AI shopping agent just got tricked into trying to pay a scammer — and it *couldn't*. Not 'it decided not to' — it was structurally incapable. That's Hundi: a trust layer that lets AI agents pay on Razorpay, where every rupee is explainable, bounded, gated, and audited. Let me show you how it works — and how I broke my own security model and fixed it."

### [0:25–1:00] The problem — the citable gap

**SAY:**
> "AI agents are about to start buying things for us. The hard part isn't finding the product — it's paying *safely*. Razorpay already ships an MCP server that lets an AI call payment APIs directly. It works — but there's no policy layer between the AI and the money. The agent effectively holds the keys. Hundi is the deterministic layer that belongs in that gap: a human signs a spending mandate, and money only moves through a facilitator that checks every rule before it settles — the only code that ever touches a Razorpay key."

### [1:00–1:40] The architecture — show you built an engine, not a demo

**SHOW:** `docs/how-it-works.html` — scroll the component diagram + the two-key diagram.

**SAY:**
> "Three actors. A human, who sets the rules and approves big purchases. An AI agent, which shops. And a facilitator — the trust boundary, the only key holder. The security rests on a two-key model: the human's key signs the mandate and approvals; the agent's key — embedded inside the human-signed mandate — signs only the shopping carts. So the agent can shop, but it can *never* approve its own payment, because it doesn't hold the human's key. Under the hood: a deterministic verification engine, a settlement state machine, a hash-chained tamper-evident ledger, idempotency, webhook reconciliation, and an auto-refund compensator for race conditions. 405 automated tests."

### [1:40–3:30] The demo — six behaviors, live

**SHOW:** terminal → `pnpm --filter @hundi/demo demo` (or click through the dashboard buttons). Narrate as each stage prints/happens.

**SAY:**
> - "**A normal purchase** — the agent picks a shoe under the cap, it's verified, and it's a real Razorpay test-mode payment. Zero human clicks."
> - "**Overspend** — it tries a cart above the cap. Refused. The agent *cannot* exceed the mandate."
> - "**The human gate** — a purchase above your threshold blocks and waits for a human signature. Not a button anyone could click — a cryptographic approval only the human's key can produce."
> - "**Prompt injection** — a poisoned store listing tells the agent to pay a different merchant. The agent falls for it — and the facilitator blocks the payment anyway, because the approved-merchant list is signed."
> - "**Failure recovery** — a payment fails three times, so it hands the human a payment link — and when the dead attempt pays late anyway, it's automatically refunded. No retained double-charge, ever."
> - "**Revocation** — the human revokes mid-session, and the very next action is refused."

### [3:30–4:00] The audit trail — "would you trust it"

**SHOW:** dashboard Live ledger → click "Verify chain" → green ✓.

**SAY:**
> "Every one of those is written to a hash-chained, append-only ledger — what happened, when, and why. One click verifies the whole chain is authentic. And I'm honest about the limit: this is tamper-*evidence*, not tamper-prevention — so in the demo, the recording itself anchors the ledger's head hash externally."

### [4:00–4:35] What broke — the story judges read first

**SAY:**
> "The most important thing I did on this build: I ran an adversarial review against my *own* core claim — 'the agent can't approve its own payments.' And I found it was false. One cryptographic key was doing three jobs, so the agent could have signed its own approval. I fixed the *architecture* — split it into two keys — and turned the exploit into a test that now fails closed. In agentic payments, the audit trail is the liability defense, so I hold my own design to that standard."

### [4:35–5:00] Close — the ask

**SAY:**
> "Razorpay proved the consent model at the rail level with Reserve Pay. Hundi is the open software trust layer and audit trail that sits on top — and a CLI makes any store agent-transactable in one command. The window to build this in the open is closing fast, and finishing it means building it inside Razorpay. That's exactly what this program is for."

---

## Delivery notes

- **Lead with the block or the scam-test**, never a slow intro. The first 15 seconds decide whether a judge keeps watching.
- Keep it calm and specific. Every claim here is backed by something in the repo — you can defend all of it.
- If a live payment is slow on camera, use the `demo` command (deterministic, always 6/6) as the spine and show the dashboard for the visual.
- Record twice, keep the better take. Have `docs/how-it-works.html` bookmarked in case a judge asks "how does it actually work" — that's your Q&A backup.

## Panel Q&A — have these answers ready

- *"Can the agent buy anything?"* → No — bounded amount, approved merchants, time-limited, single-use, big buys need a human signature. Worst case is ceiling-bounded loss at a store you already trusted; set threshold to ₹0 to approve everything manually.
- *"How does it choose the product?"* → Today, cheapest-in-stock match (deliberately simple). The point is the *safety doesn't depend on the agent being smart* — swap in the Claude brain and the guardrails don't change.
- *"Isn't this just the MCP server?"* → The MCP server lets an LLM call payment APIs with no policy layer. Hundi is the deterministic policy layer that belongs between the agent and the money. Complement, not competitor.
- *"Who audits the auditor?"* → The ledger is tamper-evident, not tamper-proof — a DB owner could rewrite it from genesis. That's why the head hash is anchored externally (the demo recording, or a git commit).
