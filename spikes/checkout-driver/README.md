# Checkout Driver Spike — Rail (b): Embedded Checkout + Playwright

Decides whether a Razorpay TEST-mode payment can be completed **hands-free**
by Playwright driving the embedded Standard Checkout overlay (checkout.js),
as a fallback to rail (a) (server-to-server UPI collect), which
`rail-matrix/` found enablement-blocked on this test account.

## What this proves

`run-spike.ts` starts a local host page (`checkout-page.ts`) that opens real
Razorpay Standard Checkout via `checkout.js`, creates a ₹1 order against the
live TEST API, and drives the checkout UI with Playwright
(`settleViaCheckout` in `drive.ts`) through to a terminal payment status —
with the API poll (`GET /v1/orders/:id/payments`), not the DOM handler, as
the source of truth.

## Setup

```bash
pnpm --dir /Users/ashutoshkumarsingh/hundi/spikes install
npx playwright install chromium   # once
```

Reads `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` from `../../.env` via the
same loader `rail-matrix/` uses (`../rail-matrix/lib.ts`).

## Run

```bash
pnpm --filter spikes checkout-driver                 # happy path
pnpm --filter spikes checkout-driver -- --fail        # failure-injection
pnpm --filter spikes checkout-driver -- --repeat 5     # V14 falsifier
```

or directly:

```bash
npx tsx checkout-driver/run-spike.ts
npx tsx checkout-driver/run-spike.ts --fail
npx tsx checkout-driver/run-spike.ts --repeat 5
```

## Payment method: Netbanking, not UPI

The task assumption going in was UPI collect (`success@razorpay` /
`failure@razorpay` pseudo-VPAs, Razorpay's documented test mechanism). Live
testing against this account's checkout found two dead ends before landing
on the working path:

1. **UPI is not offered at all.** The checkout method list on this account
   shows only Cards / Netbanking / Wallet / Pay Later — verified zero
   occurrences of "UPI" anywhere in the rendered checkout DOM across many
   fresh orders. Consistent with rail (a)'s finding that this fresh
   self-serve test account is enablement-gated. `selectUpiMethod` /
   `fillVpaAndPay` are kept in `drive.ts`, exported but unused, to swap back
   in if the account is later enabled for UPI.
2. **Card + OTP is blocked by bot detection, not a selector bug.** The
   generic Stripe/Visa test number (`4111111111111111`) gets BIN-classified
   as international and rejected outright by this India-only merchant. The
   real Razorpay-documented domestic test card (`4100280000001007`) does
   submit and creates a payment, but the "Sending OTP" step never resolves
   under Playwright — confirmed stuck for 90+ seconds with zero further
   network activity, reproduced under both headless bundled Chromium and
   headed real Chrome with `--disable-blink-features=AutomationControlled`
   and `navigator.webdriver` masked. Network trace during that step shows
   Sardine.ai device fingerprinting (`enablePortScanning: true`, and dozens
   of actual `GET http://localhost:<port>/*.png` probes against common
   automation-tool ports), Stripe Radar + hCaptcha + HumanSecurity all
   loading, and a PerimeterX-style bundle (`client.px-cloud.net`) throwing
   an uncaught `EvalError` — consistent with a client-side risk check that
   never resolves under an automated browser, permanently stalling the
   OTP-send call that would otherwise follow.
3. **Netbanking works cleanly.** Selecting a bank opens a genuine
   `window.open` popup straight to Razorpay's own mock bank page
   (`/v1/gateway/mocksharp/payment`, "Welcome to Razorpay Software Private
   Ltd Bank") with plain **Success** / **Failure** buttons — no OTP, no
   Sardine/Stripe/hCaptcha machinery. This is the flow `drive.ts` actually
   drives. Razorpay's own test-mode docs describe this same "mock bank page
   with Success and Failure buttons" pattern for netbanking/wallet test
   payments.

`--fail` clicks **Failure** on the mock bank page instead of **Success** —
this replaces `failure@razorpay` as the failure-injection mechanism and is
fully deterministic (no dependency on VPA-based simulation at all).

## Known selector gotchas (all live in `drive.ts`)

- **Contact-details dialog appears on every run**, regardless of
  `prefill.contact`. Its mobile-number field is `type="tel"` — same as the
  card number/expiry/CVV fields — so a bare `input[type="tel"]` selector
  silently grabs the wrong (obscured-behind-the-modal) field. Scope to
  `input[name="contact"]` specifically.
- **Checkout v2 rejects "fake-looking" numbers** — repeated-digit
  (`9999999999`) and simple sequential (`9876543210`, `7777777777`) mobile
  numbers fail client-side validation with "Please enter a valid mobile
  number," independent of any automation detection. Use a realistic,
  non-repeating number.
- **Netbanking bank availability is flaky per-session** — Razorpay's test
  environment randomly flags some banks with a simulated "currently facing
  issues" banner. `selectNetbankingBank` races a `context.waitForEvent
  ('page')` (the mock-bank popup) against that banner per candidate bank and
  falls through a short list (`NETBANK_CANDIDATES`) rather than trusting the
  first pick.
- **Never `waitForNetworkidle`** — checkout.js keeps a long-poll connection
  open for the lifetime of the overlay, so networkidle never resolves.
  `domcontentloaded` only.
- **Clicks need `force: true`** in a few places (contact-dialog Continue,
  bank row) due to animation/overlay transitions Playwright's actionability
  check doesn't settle past in time.

## Decision rule

> Netbanking rail proven hands-free, deterministic Success/Failure,
> 5/5 on repeat, zero bot friction observed ⇒ rail (b) viable via Netbanking.
> Card rail is NOT viable for automation on this account (OTP step blocked
> by fraud-detection tooling that never resolves under a headless/headed
> Playwright browser). UPI rail unavailable on this account entirely.
