import type Database from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { transitionSettlement } from '../state-machine.js'

/** Fresh in-memory DB per call — tests never share state. */
export function openTestDb(): Database.Database {
  return openDb(':memory:')
}

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

type MandateOverrides = Partial<{
  mandate_id: string
  intent_json: string
  intent_hash_hex: string
  credential_type: 'ed25519' | 'webauthn-es256'
  credential_public_key: string
}>

export function insertMandate(db: Database.Database, overrides: MandateOverrides = {}): string {
  const mandateId = overrides.mandate_id ?? nextId('mandate')
  db.prepare(
    `INSERT INTO mandates (mandate_id, intent_json, intent_hash_hex, credential_type, credential_public_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    mandateId,
    overrides.intent_json ?? '{}',
    overrides.intent_hash_hex ?? nextId('intent-hash'),
    overrides.credential_type ?? 'ed25519',
    overrides.credential_public_key ?? 'pubkey',
  )
  return mandateId
}

type SettlementOverrides = Partial<{
  id: string
  mandate_id: string
  cart_json: string
  mandate_cart_hash_hex: string
  amount_paise: number
  merchant_id: string
  state: string
  kick_count: number
  /** Backdates every `*_at` timestamp column that's non-null for `state` to this
   * unix-seconds value — the sweep's staleness rules key off these columns, so
   * tests seed an "old" row by setting this rather than sleeping in real time. */
  agedAt: number
}>

const SETTLEMENT_STATE_TIMESTAMP_COLUMN: Record<string, string> = {
  created: 'created_at',
  verifying: 'verifying_at',
  verified: 'verified_at',
  pending_approval: 'pending_approval_at',
  approved: 'approved_at',
  settling: 'settling_at',
  captured: 'captured_at',
  failed: 'failed_at',
  rejected: 'rejected_at',
  abandoned: 'abandoned_at',
}

export function insertSettlement(
  db: Database.Database,
  overrides: SettlementOverrides = {},
): string {
  const id = overrides.id ?? nextId('settlement')
  const mandateId = overrides.mandate_id ?? insertMandate(db)
  const state = overrides.state ?? 'created'
  db.prepare(
    `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id, state, kick_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    mandateId,
    overrides.cart_json ?? '{}',
    overrides.mandate_cart_hash_hex ?? nextId('cart-hash'),
    overrides.amount_paise ?? 1000,
    overrides.merchant_id ?? 'merchant-1',
    state,
    overrides.kick_count ?? 0,
  )
  if (overrides.agedAt !== undefined) {
    // created_at always applies (every row gets one on insert); the state-specific
    // column only applies to states past 'created' — 'created' itself has no
    // separate column beyond created_at.
    db.prepare('UPDATE settlements SET created_at = ? WHERE id = ?').run(overrides.agedAt, id)
    const column = SETTLEMENT_STATE_TIMESTAMP_COLUMN[state]
    if (column && column !== 'created_at') {
      db.prepare(`UPDATE settlements SET ${column} = ? WHERE id = ?`).run(overrides.agedAt, id)
    }
  }
  return id
}

type AttemptOverrides = Partial<{
  id: string
  settlement_id: string
  method: string
  state: string
  receipt: string
  provider_order_id: string
  provider_payment_id: string
  /** Backdates `created_at` and `updated_at` — the sweep's attempt-staleness rule
   * keys off `created_at`. */
  agedAt: number
}>

export function insertAttempt(db: Database.Database, overrides: AttemptOverrides = {}): string {
  const id = overrides.id ?? nextId('attempt')
  const settlementId = overrides.settlement_id ?? insertSettlement(db)
  db.prepare(
    `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt, provider_order_id, provider_payment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    settlementId,
    overrides.method ?? 's2s_api',
    overrides.state ?? 'initiated',
    overrides.receipt ?? nextId('receipt'),
    overrides.provider_order_id ?? null,
    overrides.provider_payment_id ?? null,
  )
  if (overrides.agedAt !== undefined) {
    db.prepare('UPDATE settlement_attempts SET created_at = ?, updated_at = ? WHERE id = ?').run(
      overrides.agedAt,
      overrides.agedAt,
      id,
    )
  }
  return id
}

/** Walks a settlement through the only path to 'failed' (created -> ... -> settling -> failed). */
export function driveSettlementToFailed(db: Database.Database, id: string): void {
  transitionSettlement(db, id, 'created', 'verifying')
  transitionSettlement(db, id, 'verifying', 'verified')
  transitionSettlement(db, id, 'verified', 'approved')
  transitionSettlement(db, id, 'approved', 'settling')
  transitionSettlement(db, id, 'settling', 'failed')
}
