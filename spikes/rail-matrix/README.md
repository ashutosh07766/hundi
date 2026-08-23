# Rail Matrix Spike — Razorpay TEST mode, rail (a): S2S UPI collect

U1 of the Hundi build. Decides whether Razorpay's server-to-server UPI
collect flow (no hosted checkout page in the loop) is viable as the payment
rail, without driving a browser.

**Timebox: 3 hours.** If rail (a) isn't decided one way or the other inside
that window, stop and escalate rather than continuing to debug — see the
decision rule below.

## Setup

All scripts read `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`
from `../../.env` (the repo-root `.env`, two levels up from this directory).
They never hardcode or log the secret values.

```bash
pnpm install
```

Run scripts with `tsx` from `spikes/`:

```bash
pnpm --filter spikes exec tsx rail-matrix/s2s-probe.ts
```

or via the package scripts:

```bash
pnpm --filter spikes s2s-probe
```

## Run order

### 0. Start the webhook listener + tunnel (do this first, leave it running)

```bash
pnpm --filter spikes webhook-listener            # verifying mode
# or, before RAZORPAY_WEBHOOK_SECRET is set in .env:
pnpm --filter spikes exec tsx rail-matrix/webhook-listener.ts --no-verify
```

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:8787
```

Copy the `https://<random>.trycloudflare.com` URL cloudflared prints. In the
Razorpay dashboard, go to **Settings → Webhooks → Add New Webhook** and:

- Webhook URL: `https://<random>.trycloudflare.com/webhook`
- Secret: generate one, paste it into `RAZORPAY_WEBHOOK_SECRET` in the
  root `.env`, restart the listener (drop `--no-verify` once it's set)
- Active events to subscribe: `payment.captured`, `payment.failed`,
  `payment_link.paid`, `refund.processed`

Leave the listener + tunnel running for the rest of the matrix — steps 1-5
below will trigger `payment.captured` / `payment.failed` events that should
show up in its log.

### 1. S2S happy path

```bash
pnpm --filter spikes s2s-probe
```

Creates a ₹1 order, attempts server-to-server UPI collect against
`success@razorpay`, polls until the payment captures (or times out). Exit
code 0 only on `captured`. **If Razorpay returns an enablement/feature error
on the payment-create call, that error IS the answer for this rail** — read
the full printed error body, don't retry it.

### 2. S2S failure injection

```bash
pnpm --filter spikes s2s-failure-probe
```

Same flow against `failure@razorpay`. Success = the payment reaches status
`failed`. Proves this rail can simulate failed payments for testing, not
just happy-path captures.

### 3. Duplicate-receipt idempotency

```bash
pnpm --filter spikes dup-receipt-probe
```

Creates two orders with the identical `receipt` string. Expected: the second
is rejected for receipt uniqueness. If Razorpay's docs turn out to be wrong
and it's **not** rejected, the script prints `DUPLICATE_ALLOWED` loudly —
that's a real finding, not a bug, and it changes the idempotency-key design
(receipt strings alone won't dedupe orders).

### 4. Payment Links (rail (b) building block, not a full driver)

```bash
pnpm --filter spikes payment-link-probe
```

Creates a payment link, prints `short_url` + `id`, then creates a second
link with the same `reference_id` and expects a 400. This only proves
creation + uniqueness — it does not drive the hosted page. If rail (a) is
blocked, the checkout-driver spike (browser automation against the hosted
page) is a separate follow-up task, not built here.

### 5. Repeat-volume falsifier

```bash
pnpm --filter spikes repeat-probe
```

Runs the S2S happy flow 5x back-to-back with fresh receipts, printing
per-run latency and outcome plus a summary (`successCount` out of 5). Bot
detection / rate friction on this rail shows up here, not on a single run.

## Decision rule

> rail (a) passes full matrix ⇒ skip rails (b)/(c), write
> `docs/decisions/001-payment-rail.md`
>
> rail (a) enablement-blocked ⇒ escalate to the checkout-driver spike
> (separate task)

## Known API-shape uncertainties encoded in this spike

- `POST /payments/create/json` is **not** in Razorpay's public REST API
  reference. It's the endpoint their own test-mode tooling uses for headless
  UPI simulation. `s2s-probe.ts` treats a `404` on the v1 host as "try an
  unversioned `/v2` host on the same path" — there is no public
  documentation of a v2 shape for this endpoint, so that fallback is itself
  part of what this spike is testing, not a known-good path.
- Whether `success@razorpay` / `failure@razorpay` VPAs work identically for
  S2S collect as they do for the hosted-checkout UPI intent flow is
  unverified — this spike is the first place that's being checked.
