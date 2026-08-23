# Dashboard ↔ Facilitator read-endpoint contract

The dashboard (`apps/dashboard`) is built against these facilitator endpoints.
The write endpoints (`POST /ceremony-tokens`, `POST /mandates`, `POST
/approvals`, `POST /revoke`) already exist and are used as-is — see
`packages/facilitator/src/routes/*`. The endpoints below do **not** exist yet
in the facilitator as of this writing; this file is the contract the
facilitator side should implement to, so the two sides land in sync.

All shapes are the JSON body returned on `200 OK`. Every existing facilitator
route wraps success as `{ ok: true, ...fields }` and failure as `{ ok: false,
error: string, detail?: string }` — these follow the same envelope, with the
one documented exception below.

## `GET /settlements?state=<optional SettlementState>`

```ts
{
  ok: true,
  settlements: Array<{
    id: string
    mandate_id: string              // needed to join against GET /mandates for goal/ceiling context
    state: string                    // SettlementState, e.g. 'pending_approval'
    amount_paise: number
    merchant_id: string
    mandate_cart_hash_hex: string
    cart_json: string                 // JSON.stringify(CartMandate) — dashboard parses client-side
    created_at: number                 // unix seconds
    reject_reason: string | null
  }>
}
```

Backed by `SELECT * FROM settlements [WHERE state = ?] ORDER BY created_at
DESC` (or similar) — every field above is already a real column on
`settlements` (see `db/schema.sql`), including `mandate_id`.

## `GET /settlements/:id`

Already exists (`routes/settlements.ts`) — used as-is, no change needed.

## `GET /mandates`

```ts
{
  ok: true,
  mandates: Array<{
    mandate_id: string
    intent_json: string     // JSON.stringify(IntentMandate) — dashboard parses client-side
    revoked_at: number | null
    created_at: number
  }>
}
```

## `GET /ledger?limit=<n>`

```ts
{
  ok: true,
  events: Array<{
    seq: number
    event_type: string        // LedgerEventType (see ledger.ts)
    settlement_id: string | null
    actor: string
    payload: Record<string, unknown>   // PARSED JSON, not the raw string column
    created_at: number
    row_hash: string
  }>
}
```

Order doesn't matter — the dashboard sorts by `seq` descending client-side
before rendering newest-first.

## `GET /ledger/verify`

**Exception to the envelope convention above**: `{ ok: false }` here is a
meaningful result (the hash chain IS broken), not a request failure. Return
`200 OK` in both cases; only a genuine server error should be a non-2xx
status.

```ts
{ ok: true, head: string, count: number }
  | { ok: false, brokenAtSeq: number }
```

Backed directly by `verifyLedger(db)` from `ledger.ts` — no new logic needed,
just an HTTP wrapper.

## Human signer identity (write endpoints)

The write endpoints above accept whichever `Credential` the dashboard's
currently active human signer resolves to — the facilitator's schema layer
already validates both shapes (`packages/facilitator/src/schemas.ts`), so no
facilitator change was needed to add the second one:

- `{ type: 'ed25519', publicKey_hex }` — the default. A raw Ed25519 keypair
  generated and held in the page's JS heap (`lib/signing.ts`).
- `{ type: 'webauthn-es256', publicKey_jwk }` — opt-in. A registered
  platform passkey; the private key never leaves the authenticator
  (`lib/webauthn.ts`). Selected via the signer toggle in `IdentityBar`.

Which credential a given mandate carries is fixed at ceremony time (whatever
`humanCredential()` resolved to when `POST /mandates` ran) — approvals and
revocations for that mandate must come from the same identity, since the
facilitator verifies against the mandate's originally registered credential,
not against whatever signer is currently active in the dashboard. See
`lib/human-signer.ts` for the dispatch logic.
