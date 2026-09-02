/**
 * Reads the mandates table and reconstitutes core's `Credential` /
 * `IntentMandate` shapes from stored columns. Centralized so every route
 * that needs "the credential registered for this mandate" (verify context,
 * /approvals, /revoke, /decisions) decodes the same two columns the same
 * way — credential_type picks which of publicKey_hex/publicKey_jwk the
 * credential_public_key column holds.
 */

import type { Credential, IntentMandate } from '@hundi/core'
import type Database from 'better-sqlite3'

export type MandateRow = {
  mandate_id: string
  intent_json: string
  intent_hash_hex: string
  credential_type: 'ed25519' | 'webauthn-es256'
  credential_public_key: string
  revoked_at: number | null
  created_at: number
}

export function getMandateRow(db: Database.Database, mandateId: string): MandateRow | undefined {
  return db.prepare('SELECT * FROM mandates WHERE mandate_id = ?').get(mandateId) as
    | MandateRow
    | undefined
}

export function credentialFromRow(
  row: Pick<MandateRow, 'credential_type' | 'credential_public_key'>,
): Credential {
  return row.credential_type === 'ed25519'
    ? { type: 'ed25519', publicKey_hex: row.credential_public_key }
    : { type: 'webauthn-es256', publicKey_jwk: JSON.parse(row.credential_public_key) as JsonWebKey }
}

/** The intent as originally registered — trusted because we wrote it ourselves post-verification. */
export function intentFromRow(row: Pick<MandateRow, 'intent_json'>): IntentMandate {
  return JSON.parse(row.intent_json) as IntentMandate
}

export function encodeCredentialPublicKey(credential: Credential): string {
  return credential.type === 'ed25519'
    ? credential.publicKey_hex
    : JSON.stringify(credential.publicKey_jwk)
}

/**
 * Cumulative captured spend under one mandate, in paise — the single definition
 * of "how much has this wallet spent". Both the verify gate (does this cart fit
 * the remaining ceiling) and the read model (GET /mandates remaining_paise) go
 * through here so the two can never drift; a drift is exactly what caused the
 * false-balance bug the cumulative wallet was built to fix. Only `captured`
 * settlements count — an in-flight one hasn't spent yet, and
 * `one_live_settlement_per_mandate` keeps at most one in flight so this sum is
 * stable for the life of the cart being verified.
 */
export function getCapturedSpend(db: Database.Database, mandateId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_paise), 0) AS spent FROM settlements
       WHERE mandate_id = ? AND state = 'captured'`,
    )
    .get(mandateId) as { spent: number }
  return row.spent
}

/** Cumulative captured spend under one mandate AT a specific merchant, in paise —
 * for enforcing a per-merchant sub-ceiling. Same "captured only" definition as
 * {@link getCapturedSpend}, narrowed by merchant. */
export function getCapturedSpendAtMerchant(
  db: Database.Database,
  mandateId: string,
  merchantId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_paise), 0) AS spent FROM settlements
       WHERE mandate_id = ? AND merchant_id = ? AND state = 'captured'`,
    )
    .get(mandateId, merchantId) as { spent: number }
  return row.spent
}

/** Batched form of {@link getCapturedSpend} for listing every mandate's spend in
 * one query. Same definition of "spent" — a mandate absent from the map has no
 * captured settlements, i.e. spend 0. */
export function getCapturedSpendByMandate(db: Database.Database): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT mandate_id, COALESCE(SUM(amount_paise), 0) AS spent
       FROM settlements WHERE state = 'captured' GROUP BY mandate_id`,
    )
    .all() as { mandate_id: string; spent: number }[]
  return new Map(rows.map((r) => [r.mandate_id, r.spent]))
}
