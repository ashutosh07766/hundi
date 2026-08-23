/**
 * Settlement creation. Runs entirely inside the caller's transaction: the
 * reservation (the settlements row insert itself, guarded by the
 * one_live_settlement_per_mandate and one_settlement_per_cart partial
 * unique indexes — see db/schema.sql), the verify-chain run, the resulting
 * state transition, and its ledger entry all commit or roll back together.
 *
 * A constraint violation on the reservation insert is caught here rather
 * than left to propagate, so the transaction can still commit — the caller
 * writes an idempotency-key completion row in the same transaction even
 * when no settlement row exists.
 */

import type { CartMandate, IntentMandate } from '@hundi/core'
import { verifyChain } from '@hundi/core'
import type Database from 'better-sqlite3'
import { type ApiErrorBody, errorBody, isSqliteConstraintError } from './errors.js'
import { appendLedger } from './ledger.js'
import { getMandateRow } from './mandate-repo.js'
import { transitionSettlement } from './state-machine.js'
import { buildVerifyCtx, computeMandateCartHash } from './verify-logic.js'

export type CreateSettlementBody =
  | { ok: true; settlement_id: string; state: string; reason?: string }
  | ApiErrorBody

export type CreateSettlementOutcome = {
  status: number
  body: CreateSettlementBody
}

export function createSettlement(
  db: Database.Database,
  settlementId: string,
  intent: IntentMandate,
  cart: CartMandate,
  now: number,
): CreateSettlementOutcome {
  // settlements.mandate_id is a real FK to mandates(mandate_id) (see db/schema.sql) — an
  // unregistered mandate can't even be the subject of an INSERT, let alone a reservation,
  // so this is checked before attempting one rather than caught as a constraint violation.
  if (!getMandateRow(db, intent.mandateId)) {
    return { status: 404, body: errorBody('MANDATE_UNKNOWN') }
  }

  const mandateCartHashHex = computeMandateCartHash(intent, cart)

  try {
    db.prepare(
      `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      settlementId,
      intent.mandateId,
      JSON.stringify(cart),
      mandateCartHashHex,
      cart.total_paise,
      cart.merchant_id,
    )
  } catch (err) {
    if (!isSqliteConstraintError(err)) throw err
    // The two partial unique indexes both fire "UNIQUE constraint failed" — the column
    // named in the message is the only way to tell which invariant tripped.
    if (err.message.includes('mandate_cart_hash_hex')) {
      return { status: 409, body: errorBody('DUPLICATE_CART') }
    }
    if (err.message.includes('settlements.mandate_id')) {
      return { status: 409, body: errorBody('ALLOWANCE_RESERVED') }
    }
    throw err
  }

  transitionSettlement(db, settlementId, 'created', 'verifying')

  const { ctx } = buildVerifyCtx(db, intent, cart, now, { excludeSettlementId: settlementId })
  const result = verifyChain(intent, cart, ctx)

  if (!result.ok) {
    transitionSettlement(db, settlementId, 'verifying', 'rejected', { rejectReason: result.reason })
    appendLedger(db, {
      event_type: 'verify_rejected',
      settlement_id: settlementId,
      actor: 'facilitator',
      payload:
        result.detail === undefined
          ? { reason: result.reason }
          : { reason: result.reason, detail: result.detail },
    })
    return {
      status: 202,
      body: { ok: true, settlement_id: settlementId, state: 'rejected', reason: result.reason },
    }
  }

  transitionSettlement(db, settlementId, 'verifying', 'verified')

  if (result.needsApproval) {
    transitionSettlement(db, settlementId, 'verified', 'pending_approval')
    appendLedger(db, {
      event_type: 'approval_requested',
      settlement_id: settlementId,
      actor: 'facilitator',
      payload: { mandate_cart_hash_hex: result.mandateCartHashHex },
    })
    return {
      status: 202,
      body: { ok: true, settlement_id: settlementId, state: 'pending_approval' },
    }
  }

  transitionSettlement(db, settlementId, 'verified', 'approved')
  appendLedger(db, {
    event_type: 'verify_passed',
    settlement_id: settlementId,
    actor: 'facilitator',
    payload: { mandate_cart_hash_hex: result.mandateCartHashHex },
  })
  return { status: 202, body: { ok: true, settlement_id: settlementId, state: 'approved' } }
}
