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
