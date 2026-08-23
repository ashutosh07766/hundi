import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import type { CanonicalValue } from '@hundi/core'
import { canonicalJson, sha256Hex, verifyMandateSignature } from '@hundi/core'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { tx } from '../db/index.js'
import { RouteError } from '../errors.js'
import { claimIdempotencyKey, completeIdempotencyKey } from '../idempotency.js'
import { appendLedger } from '../ledger.js'
import { intentFromRow } from '../mandate-repo.js'
import { createSettlementBodySchema, decisionBodySchema } from '../schemas.js'
import { createSettlement } from '../settlement-service.js'

type SettlementRow = {
  id: string
  mandate_id: string
  cart_json: string
  mandate_cart_hash_hex: string
  amount_paise: number
  merchant_id: string
  state: string
}

/**
 * POST /settlements, GET /settlements/:id, POST /settlements/:id/decisions.
 * The create route owns the full idempotency-key contract (see
 * idempotency.ts) and delegates the actual reservation/verify/transition
 * work to settlement-service.ts so this file stays HTTP-shape concerns only.
 */
export function registerSettlementRoutes(app: Hono, { db, executor }: AppDeps): void {
  app.post('/settlements', zValidator('json', createSettlementBodySchema), (c) => {
    const idempotencyKey = c.req.header('Idempotency-Key')
    if (!idempotencyKey) throw new RouteError(400, 'IDEMPOTENCY_KEY_REQUIRED')

    const body = c.req.valid('json')
    const requestHashHex = sha256Hex(canonicalJson(body as unknown as CanonicalValue))

    const claim = claimIdempotencyKey(db, idempotencyKey, requestHashHex)
    if (claim.state === 'hash_mismatch') throw new RouteError(409, 'KEY_REUSED')
    if (claim.state === 'in_flight') throw new RouteError(409, 'IN_FLIGHT')
    if (claim.state === 'completed') {
      return c.body(claim.body, claim.status as 200 | 202 | 400 | 401 | 404 | 409, {
        'Content-Type': 'application/json',
      })
    }

    const settlementId = randomUUID()
    const now = Math.floor(Date.now() / 1000)

    const outcome = tx(db, () => {
      const result = createSettlement(db, settlementId, body.intent, body.cart, now)
      const bodyStr = JSON.stringify(result.body)
      const persistedSettlementId = result.body.ok ? result.body.settlement_id : null
      completeIdempotencyKey(db, idempotencyKey, persistedSettlementId, result.status, bodyStr)
      return result
    })

    if (outcome.body.ok && outcome.body.state === 'approved') {
      executor.execute(settlementId)
    }

    return c.body(
      JSON.stringify(outcome.body),
      outcome.status as 200 | 202 | 400 | 401 | 404 | 409,
      {
        'Content-Type': 'application/json',
      },
    )
  })

  app.get('/settlements/:id', (c) => {
    const id = c.req.param('id')
    const settlement = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as
      | SettlementRow
      | undefined
    if (!settlement) throw new RouteError(404, 'SETTLEMENT_NOT_FOUND')

    const attempts = db
      .prepare('SELECT * FROM settlement_attempts WHERE settlement_id = ? ORDER BY created_at ASC')
      .all(id)
    const approval = db.prepare('SELECT * FROM approvals WHERE settlement_id = ?').get(id) ?? null
    const ledger = db
      .prepare('SELECT * FROM ledger_events WHERE settlement_id = ? ORDER BY seq DESC LIMIT 50')
      .all(id)

    return c.json({ ok: true, settlement, attempts, approval, ledger }, 200)
  })

  app.post('/settlements/:id/decisions', zValidator('json', decisionBodySchema), (c) => {
    const id = c.req.param('id')
    const { payload, signature_hex } = c.req.valid('json')

    const settlement = db.prepare('SELECT mandate_id FROM settlements WHERE id = ?').get(id) as
      | { mandate_id: string }
      | undefined
    if (!settlement) throw new RouteError(404, 'SETTLEMENT_NOT_FOUND')

    const mandateRow = db
      .prepare('SELECT intent_json FROM mandates WHERE mandate_id = ?')
      .get(settlement.mandate_id) as { intent_json: string } | undefined
    if (!mandateRow) throw new RouteError(404, 'MANDATE_UNKNOWN')

    const intent = intentFromRow(mandateRow)
    // Verified against the agent's own key (from the intent), not the mandate's registered
    // credential — a webauthn-registered mandate's agent still signs decisions with its ed25519 key.
    const agentCredential: { type: 'ed25519'; publicKey_hex: string } = {
      type: 'ed25519',
      publicKey_hex: intent.agent_pubkey_hex,
    }
    const payloadBytes = canonicalJson(payload as unknown as CanonicalValue)

    const valid = verifyMandateSignature(
      payloadBytes,
      { type: 'ed25519', signature_hex },
      agentCredential,
    )
    if (!valid) throw new RouteError(401, 'AGENT_SIG_INVALID')

    const pubkey8 = intent.agent_pubkey_hex.slice(0, 8)
    tx(db, () => {
      appendLedger(db, {
        event_type: 'agent_decision',
        settlement_id: id,
        actor: `agent:${pubkey8}`,
        payload: payload as unknown as { readonly [key: string]: CanonicalValue },
      })
    })

    return c.json({ ok: true }, 200)
  })
}
