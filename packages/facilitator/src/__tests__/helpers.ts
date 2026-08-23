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
}>

export function insertSettlement(
  db: Database.Database,
  overrides: SettlementOverrides = {},
): string {
  const id = overrides.id ?? nextId('settlement')
  const mandateId = overrides.mandate_id ?? insertMandate(db)
  db.prepare(
    `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id, state)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    mandateId,
    overrides.cart_json ?? '{}',
    overrides.mandate_cart_hash_hex ?? nextId('cart-hash'),
    overrides.amount_paise ?? 1000,
    overrides.merchant_id ?? 'merchant-1',
    overrides.state ?? 'created',
  )
  return id
}

type AttemptOverrides = Partial<{
  id: string
  settlement_id: string
  method: string
  state: string
  receipt: string
}>

export function insertAttempt(db: Database.Database, overrides: AttemptOverrides = {}): string {
  const id = overrides.id ?? nextId('attempt')
  const settlementId = overrides.settlement_id ?? insertSettlement(db)
  db.prepare(
    `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    settlementId,
    overrides.method ?? 's2s_api',
    overrides.state ?? 'initiated',
    overrides.receipt ?? nextId('receipt'),
  )
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
