import { zValidator } from '@hono/zod-validator'
import { canonicalJson, verifyMandateSignature } from '@hundi/core'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { tx } from '../db/index.js'
import { RouteError } from '../errors.js'
import { appendLedger } from '../ledger.js'
import { credentialFromRow, getMandateRow } from '../mandate-repo.js'
import { revokeBodySchema } from '../schemas.js'

/** POST /revoke — revocation is signed by the mandate's own registered credential,
 * same trust root as an approval. Idempotent: revoking an already-revoked mandate
 * just confirms the state rather than erroring, since two racing revoke calls (or a
 * retried request) both express the same intent and should both succeed. */
export function registerRevokeRoute(app: Hono, { db }: AppDeps): void {
  app.post('/revoke', zValidator('json', revokeBodySchema), (c) => {
    const { mandateId, sig } = c.req.valid('json')

    const mandateRow = getMandateRow(db, mandateId)
    if (!mandateRow) throw new RouteError(404, 'MANDATE_UNKNOWN')

    const credential = credentialFromRow(mandateRow)
    const bytes = canonicalJson({ mandateId, action: 'revoke' })
    if (!verifyMandateSignature(bytes, sig, credential)) {
      throw new RouteError(401, 'REVOKE_SIG_INVALID')
    }

    if (mandateRow.revoked_at !== null) {
      return c.json({ ok: true, mandateId, alreadyRevoked: true }, 200)
    }

    tx(db, () => {
      db.prepare('UPDATE mandates SET revoked_at = unixepoch() WHERE mandate_id = ?').run(mandateId)
      appendLedger(db, {
        event_type: 'mandate_revoked',
        actor: `mandate:${mandateId}`,
        payload: {},
      })
    })

    return c.json({ ok: true, mandateId }, 200)
  })
}
