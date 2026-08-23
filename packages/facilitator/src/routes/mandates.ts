import { zValidator } from '@hono/zod-validator'
import { intentSigningBytes, sha256Hex, verifyMandateSignature } from '@hundi/core'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { tx } from '../db/index.js'
import { isSqliteConstraintError, RouteError } from '../errors.js'
import { appendLedger } from '../ledger.js'
import { encodeCredentialPublicKey } from '../mandate-repo.js'
import { mandatesBodySchema } from '../schemas.js'

/**
 * POST /mandates — registers a mandate, binding a credential to it. This IS the
 * ceremony: the credential in the body is trusted only because a single-use
 * ceremony token (minted by a dashboard-authenticated caller) is consumed
 * atomically alongside the insert, and the intent's own signature is verified
 * against that exact credential before anything is persisted.
 */
export function registerMandateRoutes(app: Hono, { db }: AppDeps): void {
  app.post('/mandates', zValidator('json', mandatesBodySchema), (c) => {
    const { intent, credential, ceremonyToken } = c.req.valid('json')

    const outcome = tx(db, () => {
      const consumed = db
        .prepare(
          'UPDATE ceremony_tokens SET used_at = unixepoch() WHERE token = ? AND used_at IS NULL',
        )
        .run(ceremonyToken)
      if (consumed.changes === 0) throw new RouteError(401, 'TOKEN_INVALID')

      const intentBytes = intentSigningBytes(intent)
      if (!verifyMandateSignature(intentBytes, intent.sig, credential)) {
        throw new RouteError(400, 'SIG_INVALID_INTENT')
      }

      const intentHashHex = sha256Hex(intentBytes)

      try {
        db.prepare(
          `INSERT INTO mandates (mandate_id, intent_json, intent_hash_hex, credential_type, credential_public_key)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          intent.mandateId,
          JSON.stringify(intent),
          intentHashHex,
          credential.type,
          encodeCredentialPublicKey(credential),
        )
      } catch (err) {
        if (isSqliteConstraintError(err)) throw new RouteError(409, 'MANDATE_EXISTS')
        throw err
      }

      db.prepare(
        'INSERT INTO allowances (mandate_id, max_amount_paise, expires_at) VALUES (?, ?, ?)',
      ).run(intent.mandateId, intent.ceiling_paise, intent.expires_at)

      appendLedger(db, {
        event_type: 'mandate_registered',
        actor: 'facilitator',
        payload: {
          mandate_id: intent.mandateId,
          intent_hash_hex: intentHashHex,
          agent_pubkey_hex: intent.agent_pubkey_hex,
        },
      })

      return { mandateId: intent.mandateId, intent_hash_hex: intentHashHex }
    })

    return c.json({ ok: true, ...outcome }, 201)
  })
}
