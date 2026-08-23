import type { MandateWalletState } from '@hundi/core'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { RouteError } from '../errors.js'
import { verifyLedger } from '../ledger.js'
import { getCapturedSpendByMandate } from '../mandate-repo.js'
import { SETTLEMENT_TRANSITIONS } from '../state-machine.js'

/** Every state the settlements.state CHECK constraint (db/schema.sql) allows —
 * derived from SETTLEMENT_TRANSITIONS so this can never drift from the state
 * machine's own notion of "valid state". */
const VALID_SETTLEMENT_STATES = new Set<string>(Object.keys(SETTLEMENT_TRANSITIONS))

const DEFAULT_LEDGER_LIMIT = 100
const MAX_LEDGER_LIMIT = 1000

type SettlementListRow = {
  id: string
  mandate_id: string
  state: string
  amount_paise: number
  merchant_id: string
  mandate_cart_hash_hex: string
  cart_json: string
  created_at: number
  reject_reason: string | null
}

type MandateListRow = {
  mandate_id: string
  intent_json: string
  revoked_at: number | null
  created_at: number
}

type LedgerEventRow = {
  seq: number
  event_type: string
  settlement_id: string | null
  actor: string
  payload: string
  created_at: number
  row_hash: string
}

/**
 * Read-only listing endpoints backing the dashboard: settlements, mandates,
 * and the ledger (raw feed + hash-chain verification). Every handler here is
 * a plain SELECT — no transaction, no ledger append, no state transition —
 * so these never need to coordinate with the write paths in the other route
 * modules.
 */
export function registerReadRoutes(app: Hono, { db }: AppDeps): void {
  app.get('/settlements', (c) => {
    const state = c.req.query('state')
    if (state !== undefined && !VALID_SETTLEMENT_STATES.has(state)) {
      throw new RouteError(400, 'INVALID_STATE')
    }

    const settlements = (
      state
        ? db
            .prepare(
              `SELECT id, mandate_id, state, amount_paise, merchant_id, mandate_cart_hash_hex, cart_json, created_at, reject_reason
               FROM settlements WHERE state = ? ORDER BY created_at DESC`,
            )
            .all(state)
        : db
            .prepare(
              `SELECT id, mandate_id, state, amount_paise, merchant_id, mandate_cart_hash_hex, cart_json, created_at, reject_reason
               FROM settlements ORDER BY created_at DESC`,
            )
            .all()
    ) as SettlementListRow[]

    return c.json({ ok: true, settlements }, 200)
  })

  app.get('/mandates', (c) => {
    const mandates = db
      .prepare(
        'SELECT mandate_id, intent_json, revoked_at, created_at FROM mandates ORDER BY created_at DESC',
      )
      .all() as MandateListRow[]

    // Cumulative wallet: captured spend accrues against the mandate's ceiling.
    // Same definition of "spent" the verify gate uses (getCapturedSpend), batched
    // here so the display balance and the enforced balance can never drift.
    const spentByMandate = getCapturedSpendByMandate(db)

    // Same 60s grace the verify gate applies to expiry, so "expired" here can't
    // disagree with what a settlement attempt would actually be rejected for.
    const now = Math.floor(Date.now() / 1000)
    const CLOCK_SKEW_SEC = 60

    const enriched = mandates.map((row) => {
      // Defense-in-depth: intent_json is Zod-validated at registration, but a
      // corrupted or hand-edited row must not 500 the whole listing (and blind
      // get_agent_identity to every other mandate). A bad row is reported with
      // state 'error' and no accounting, not omitted silently.
      let intent: { ceiling_paise: number; expires_at: number }
      try {
        intent = JSON.parse(row.intent_json) as { ceiling_paise: number; expires_at: number }
      } catch {
        return { ...row, spent_paise: null, remaining_paise: null, state: 'error' as const }
      }
      const spentPaise = spentByMandate.get(row.mandate_id) ?? 0
      const remainingPaise = Math.max(0, intent.ceiling_paise - spentPaise)
      const state: MandateWalletState =
        row.revoked_at != null
          ? 'revoked'
          : now > intent.expires_at + CLOCK_SKEW_SEC
            ? 'expired'
            : remainingPaise <= 0
              ? 'consumed'
              : 'active'
      // ceiling is available on `intent_json` (already in `...row`); the wallet
      // accounting this endpoint adds is the derived part — spent, remaining, state.
      return {
        ...row,
        spent_paise: spentPaise,
        remaining_paise: remainingPaise,
        state,
      }
    })

    return c.json({ ok: true, mandates: enriched }, 200)
  })

  app.get('/ledger', (c) => {
    const rawLimit = c.req.query('limit')
    let limit = DEFAULT_LEDGER_LIMIT
    if (rawLimit !== undefined) {
      // Reject anything that isn't a bare non-negative integer literal (no sign,
      // no decimal point, no exponent) rather than trusting Number()/parseInt(),
      // which silently accept "12.5", "1e3", or "-5" as truthy numbers.
      if (!/^\d+$/.test(rawLimit)) throw new RouteError(400, 'INVALID_LIMIT')
      limit = Math.min(Number(rawLimit), MAX_LEDGER_LIMIT)
    }

    const rows = db
      .prepare(
        'SELECT seq, event_type, settlement_id, actor, payload, created_at, row_hash FROM ledger_events ORDER BY seq DESC LIMIT ?',
      )
      .all(limit) as LedgerEventRow[]

    const events = rows.map((row) => ({
      seq: row.seq,
      event_type: row.event_type,
      settlement_id: row.settlement_id,
      actor: row.actor,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      created_at: row.created_at,
      row_hash: row.row_hash,
    }))

    return c.json({ ok: true, events }, 200)
  })

  app.get('/ledger/verify', (c) => {
    // verifyLedger's { ok: false, brokenAtSeq } is a genuine result (the chain IS
    // broken), not a request failure — always 200, unlike every other route's
    // error envelope.
    return c.json(verifyLedger(db), 200)
  })
}
