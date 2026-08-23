import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { RouteError } from '../errors.js'
import { verifyLedger } from '../ledger.js'
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

    return c.json({ ok: true, mandates }, 200)
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
