/**
 * Stage 5 — Failure recovery. The scripted driver fails all three checkout
 * attempts (packages/facilitator/src/executor.ts's `MAX_ATTEMPTS = 3`), so
 * the executor falls back to a payment link — the settlement stays
 * `settling` (nobody has paid yet) while a human finishes it out-of-band.
 *
 * Then the race: the abandoned direct-checkout attempt (already terminal —
 * `failed`, having exhausted its retries) reports a capture late, as if the
 * provider had actually completed it after the executor gave up. The
 * reconciliation authority (`handleProviderCapture`,
 * packages/facilitator/src/reconcile.ts) treats any capture landing on a
 * non-live attempt as an anomaly regardless of *why* it's non-live —
 * `failed` and `superseded` both fail the same `attemptIsLive` check — and
 * refunds it automatically. Finally the human actually pays via the link,
 * which becomes the settlement's one retained capture.
 */

import { randomUUID } from 'node:crypto'
import { HttpBuyerTools } from '../../../agents/scripted-brain/src/agent-tools.js'
import { runPurchase } from '../../../agents/scripted-brain/src/scripted-brain.js'
import { registerMandate } from '../../../agents/scripted-brain/src/session.js'
import { applyCapture, handleProviderCapture } from '../../../packages/facilitator/src/reconcile.js'
import {
  CEILING_PAISE,
  DASHBOARD_TOKEN,
  type DemoHarness,
  future,
  ledgerEventTypesFor,
  MERCHANT_ID,
} from '../harness.js'
import type { StageRun } from '../types.js'

type AttemptRow = {
  id: string
  method: string
  state: string
  provider_order_id: string | null
}

export type Stage5Detail = {
  settlementId: string
  shortUrl: string
  capturedAttemptCount: number
  anomalyRefundCount: number
}

export async function runStage5(h: DemoHarness): Promise<StageRun<Stage5Detail>> {
  h.driverController.mode = 'failed'

  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: 'buy running shoes (payment provider having a bad day)',
    ceiling_paise: CEILING_PAISE,
    approval_threshold_paise: CEILING_PAISE, // auto-approves — this stage is about settlement, not the gate
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  // A short poll timeout — the settlement never reaches a POLL_STOP_STATES
  // value here (it stays `settling` through the whole retry+fallback dance),
  // so there's no point waiting out the default 2s poll window. waitForIdle()
  // below is the real completion signal.
  const tools = new HttpBuyerTools({
    storeUrl: h.storeUrl,
    facilitatorUrl: h.facilitatorUrl,
    pollIntervalMs: 5,
    pollTimeoutMs: 50,
  })

  const submission = await runPurchase(
    {
      goal: {
        query: 'Velocity Air Runner',
        maxItems: 1,
        ceiling_paise: CEILING_PAISE,
        threshold_paise: CEILING_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    () => {},
  )
  const settlementId = submission.settlement?.settlement_id
  if (!settlementId) {
    throw new Error(`stage 5: purchase never reached a settlement id (status ${submission.status})`)
  }

  await h.executor.waitForIdle()

  const afterRetries = h.db
    .prepare('SELECT state FROM settlements WHERE id = ?')
    .get(settlementId) as { state: string }
  if (afterRetries.state !== 'settling') {
    throw new Error(`stage 5: expected settling after fallback, got ${afterRetries.state}`)
  }

  const linkAttempt = h.db
    .prepare(
      `SELECT id, method, state, provider_order_id FROM settlement_attempts
       WHERE settlement_id = ? AND method = 'payment_link'`,
    )
    .get(settlementId) as AttemptRow | undefined
  if (!linkAttempt) throw new Error('stage 5: expected a payment_link attempt after 3 failures')

  const directAttempts = h.db
    .prepare(
      `SELECT id, method, state, provider_order_id FROM settlement_attempts
       WHERE settlement_id = ? AND method = 'checkout_driver' ORDER BY created_at ASC`,
    )
    .all(settlementId) as AttemptRow[]
  const lastDirectAttempt = directAttempts.at(-1)
  if (!lastDirectAttempt?.provider_order_id) {
    throw new Error('stage 5: expected a terminal direct attempt with a provider order id')
  }

  // The race: the abandoned direct order reports a capture after the
  // executor already gave up on it and issued the payment link.
  await handleProviderCapture(
    { db: h.db, razorpay: h.razorpay },
    { orderId: lastDirectAttempt.provider_order_id, paymentId: `late-pay-${randomUUID()}` },
  )

  // The human actually pays via the link — this becomes the one retained capture.
  const linkPaymentId = `link-pay-${randomUUID()}`
  const applied = applyCapture(
    h.db,
    {
      attemptId: linkAttempt.id,
      attemptState: 'awaiting_confirmation',
      settlementId,
      mandateId: intent.mandateId,
    },
    linkPaymentId,
  )
  if (!applied) throw new Error('stage 5: expected the payment-link capture to apply cleanly')

  const capturedAttemptCount = (
    h.db
      .prepare(
        `SELECT COUNT(*) c FROM settlement_attempts WHERE settlement_id = ? AND state = 'captured'`,
      )
      .get(settlementId) as { c: number }
  ).c
  const events = ledgerEventTypesFor(h.db, settlementId)
  const anomalyRefundCount = events.filter((e) => e === 'anomaly_refund_issued').length

  const finalState = h.db
    .prepare('SELECT state FROM settlements WHERE id = ?')
    .get(settlementId) as {
    state: string
  }
  if (finalState.state !== 'captured') {
    throw new Error(`stage 5: expected final state captured, got ${finalState.state}`)
  }
  if (capturedAttemptCount !== 1) {
    throw new Error(`stage 5: expected exactly one retained capture, got ${capturedAttemptCount}`)
  }
  if (anomalyRefundCount !== 1) {
    throw new Error(`stage 5: expected exactly one anomaly refund, got ${anomalyRefundCount}`)
  }

  const shortUrlEvent = events.includes('payment_link_issued')
  const linkPayload = h.db
    .prepare(
      `SELECT payload FROM ledger_events WHERE settlement_id = ? AND event_type = 'payment_link_issued'`,
    )
    .get(settlementId) as { payload: string } | undefined
  const shortUrl = linkPayload
    ? ((JSON.parse(linkPayload.payload) as { short_url?: string }).short_url ?? '')
    : ''
  if (!shortUrlEvent || !shortUrl)
    throw new Error('stage 5: expected a payment_link_issued short_url')

  return {
    outcome: {
      stage: 5,
      title: 'Failure recovery',
      narration:
        'Payment declined. Retried, then handed the human a link. When the dead path paid late anyway, it was auto-refunded. No retained double-charge.',
      expectedTerminal: 'captured (via payment link, after one anomaly refund)',
      ledgerEvents: events,
    },
    detail: { settlementId, shortUrl, capturedAttemptCount, anomalyRefundCount },
  }
}
