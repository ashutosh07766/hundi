# Route Matrix Spike — can Razorpay Route pay the merchant, in TEST mode?

Prove-or-pivot spike: closes (or doesn't) the "the merchant doesn't actually
get paid" gap. If Route works, the real flow is agent buys from a real
store → capture lands on our platform account → `POST /transfers`
splits settlement to the merchant's own Razorpay linked account. This spike
checks whether that's buildable on our self-serve TEST-mode account before
any of it gets built into the facilitator.

**Timebox mentality:** don't fight enablement walls, document them
precisely and move on. This is the same posture as the rail-matrix spike
(see `../rail-matrix/README.md` and `docs/decisions/001-payment-rail.md`) —
an enablement error IS the answer, not a bug to retry.

## Setup

Same `.env` as `rail-matrix` — `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
read from the repo-root `.env` via `loadEnv()`, imported directly from
`../rail-matrix/lib.ts` (no duplicated auth/logging code in this directory).

```bash
pnpm --filter spikes exec tsx route-matrix/linked-account-probe.ts
pnpm --filter spikes exec tsx route-matrix/transfer-probe.ts [acc_...]
pnpm --filter spikes exec tsx route-matrix/route-status-probe.ts
```

`transfer-probe.ts` takes an optional linked-account id as its first
argument (chain the `ROUTE_ACCOUNT_ID=acc_...` line printed by
`linked-account-probe.ts` on success). With no argument it runs against a
syntactically-valid placeholder id so the transfer endpoints still get
exercised and their error shape captured, even with zero real linked
accounts on the account.

## Run order

1. `linked-account-probe.ts` — `POST /v2/accounts` (current Route Accounts
   API shape: email/phone/`type: 'route'`/legal_business_name/business_type/
   profile.addresses). Falls back to the legacy `POST /v1/beta/accounts`
   shape only on a literal 404 (route not resolvable at all, as opposed to a
   rejected business request).
2. `transfer-probe.ts` — lists recent payments, picks the newest `captured`
   one, and attempts `POST /payments/:id/transfers` (split an existing
   payment) and `POST /transfers` (direct balance transfer) against the
   linked-account id from step 1 (or the placeholder).
3. `route-status-probe.ts` — read-only cross-checks (`GET /v2/accounts`,
   `GET /v1/beta/accounts`, `GET /transfers`) to see whether any Route
   surface is reachable independent of a create/transfer attempt.

## Verdict: **GATED**

Route is enablement-gated on this self-serve TEST-mode account, at the
account-creation step — the same class of finding as rail (a) in
`docs/decisions/001-payment-rail.md` ("the rails give you less than the
docs imply"). No linked account could be created, so the transfer probes
ran against a placeholder id and hit an unrelated URL-routing wall instead
of a business-logic rejection — consistent with the entire Route product
surface being switched off for this merchant, not just account creation.

### Exact API responses

**`POST /v2/accounts`** (linked-account-probe.ts) — real business-logic
rejection, HTTP 400, decision-critical:

```json
{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "Route feature not enabled for the merchant",
    "source": "business",
    "step": "linked_account_create",
    "reason": "NA",
    "metadata": {}
  }
}
```

This is not a malformed-request error — `source: "business"` and
`step: "linked_account_create"` mean the payload shape was accepted and
evaluated; the merchant-level Route feature flag is what's off. Because
this was a 400 (not a 404), the legacy `/v1/beta/accounts` fallback never
fired — the endpoint exists and is reachable, it just refuses this
merchant.

**`POST /payments/:id/transfers`** and **`POST /transfers`**
(transfer-probe.ts, run against a real captured payment
`pay_TTIk5Rht0u6ndv` and the placeholder account id) — both return the same
generic routing-level rejection, HTTP 400:

```json
{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "The requested URL was not found on the server.",
    "source": "internal",
    "step": "NA",
    "reason": "NA",
    "metadata": {}
  }
}
```

`source: "internal"` here (vs. `"business"` above) plus the generic "URL
not found" text is the tell that these routes aren't provisioned for this
merchant at all — not a validation failure against the placeholder account
id. `GET /v1/beta/accounts` and `GET /transfers` in route-status-probe.ts
return the identical body, and `GET /v2/accounts` returns a distinct
`{"message":"no Route matched with those values"}` 404 (a framework-level
"no route for this HTTP method" response, since `POST /v2/accounts` is the
only method registered on that path). All three read probes corroborate
the same conclusion from a different angle: Route isn't reachable for this
merchant, full stop, not just the create-account call.

## Recommendation

Route is the correct production design for "the merchant actually gets
paid" — linked accounts + transfers is exactly Razorpay's documented
primitive for split settlement, and the API contract above (request/response
shapes) is real and will work the moment Route is enabled on the merchant
account (self-serve enablement typically requires additional KYC/business
verification on the platform account, done via Razorpay support or the
dashboard — not something a spike can unblock).

For the pitch, use the honest framing established for rail (a) in
`docs/decisions/001-payment-rail.md`: **document the gate, don't fake the
transfer.** Concretely:

- State the finding as a citable data point: "test-mode Route requires
  merchant-level enablement — same posture as the S2S UPI collect gate we
  hit on Day 1 (see `docs/decisions/001-payment-rail.md`). We demonstrated
  the Accounts + Transfers API contract end-to-end (request shapes,
  response shapes, error taxonomy) against a live test account; the
  create-account call is blocked pending Razorpay's enablement review."
- Do not silently mock a fake "transfer succeeded" state in the product
  code path — see `WHAT-BROKE.md`'s Day-1 entries for why swallowing a rail
  gap this way is exactly the failure mode this project treats as a bug,
  not a workaround.
- If a demo needs to *show* the split-settlement narrative without a real
  enabled account, gate it explicitly behind a `ROUTE_MOCK_TRANSFERS` (or
  similar) env flag that the dashboard visibly labels "simulated — Route
  pending enablement," rather than presenting it as a real transfer. Visible
  degraded mode, never silent.
- Next build step if/when Route gets enabled: wire `linked-account-probe.ts`'s
  request shape into a real merchant-onboarding step in the facilitator, and
  `transfer-probe.ts`'s `POST /payments/:id/transfers` call into the
  settlement-capture path — both are copy-paste-ready from this spike, no
  API-shape research left to do.
