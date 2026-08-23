import { zValidator } from '@hono/zod-validator'
import type { CartMandate } from '@hundi/core'
import { canonicalJson, verifyMandateSignature } from '@hundi/core'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { tx } from '../db/index.js'
import { isSqliteConstraintError, RouteError } from '../errors.js'
import { appendLedger } from '../ledger.js'
import { credentialFromRow, getMandateRow, intentFromRow } from '../mandate-repo.js'
import { approvalsBodySchema } from '../schemas.js'
import { StaleTransition, transitionSettlement } from '../state-machine.js'
import { computeMandateCartHash } from '../verify-logic.js'

/**
 * POST /approvals — the human (or delegate) decision on a `pending_approval`
 * settlement. Two independent checks gate the state transition: the sig must
 * verify against the mandate's REGISTERED credential (not the agent's key —
 * approval authority belongs to whoever the ceremony bound, which may be a
 * human webauthn credential), and the mandate_cart_hash_hex the caller
 * signed over must match one we recompute from the stored intent+cart, not
 * the copy the caller sent — otherwise a caller could sign a stale hash and
 * have it applied to a different settlement's content.
 */
export function registerApprovalRoutes(app: Hono, { db, executor }: AppDeps): void {
  app.post('/approvals', zValidator('json', approvalsBodySchema), (c) => {
    const { settlement_id, mandate_cart_hash_hex, decision, sig } = c.req.valid('json')

    const settlement = db
      .prepare('SELECT mandate_id, cart_json FROM settlements WHERE id = ?')
      .get(settlement_id) as { mandate_id: string; cart_json: string } | undefined
    if (!settlement) throw new RouteError(404, 'SETTLEMENT_NOT_FOUND')

    const mandateRow = getMandateRow(db, settlement.mandate_id)
    if (!mandateRow) throw new RouteError(404, 'MANDATE_UNKNOWN')

    const credential = credentialFromRow(mandateRow)
    const decisionBytes = canonicalJson({ settlement_id, mandate_cart_hash_hex, decision })
    if (!verifyMandateSignature(decisionBytes, sig, credential)) {
      throw new RouteError(401, 'APPROVAL_SIG_INVALID')
    }

    const intent = intentFromRow(mandateRow)
    const cart = JSON.parse(settlement.cart_json) as CartMandate
    const recomputed = computeMandateCartHash(intent, cart)
    if (recomputed !== mandate_cart_hash_hex) {
      throw new RouteError(400, 'CART_HASH_MISMATCH')
    }

    const now = Math.floor(Date.now() / 1000)
    const expiresAt = Math.min(now + 1800, intent.expires_at)
    const toState = decision === 'approved' ? 'approved' : 'rejected'

    tx(db, () => {
      try {
        db.prepare(
          `INSERT INTO approvals (settlement_id, decision, mandate_cart_hash_hex, sig_json, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(settlement_id, decision, mandate_cart_hash_hex, JSON.stringify(sig), expiresAt)
      } catch (err) {
        if (isSqliteConstraintError(err)) throw new RouteError(409, 'ALREADY_DECIDED')
        throw err
      }

      try {
        transitionSettlement(
          db,
          settlement_id,
          'pending_approval',
          toState,
          decision === 'rejected' ? { rejectReason: 'approval_rejected' } : {},
        )
      } catch (err) {
        if (err instanceof StaleTransition)
          throw new RouteError(409, 'SETTLEMENT_NOT_PENDING_APPROVAL')
        throw err
      }

      appendLedger(db, {
        event_type: decision === 'approved' ? 'approval_granted' : 'approval_rejected',
        settlement_id,
        actor: `mandate:${settlement.mandate_id}`,
        payload: { mandate_cart_hash_hex },
      })
    })

    if (decision === 'approved') executor.execute(settlement_id)

    return c.json({ ok: true, settlement_id, state: toState }, 200)
  })
}
