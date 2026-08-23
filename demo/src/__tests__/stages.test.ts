/**
 * One vitest describe block per demo stage — these double as the demo
 * rehearsal (see stages.md) and as CI coverage for the choreography. Each
 * test boots its own fresh harness (fresh in-memory db, fresh listeners) for
 * full isolation; run-all.ts instead drives all six stages against one
 * shared harness so the printed ledger is one continuous chain.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { closeStore, createHarness, type DemoHarness } from '../harness.js'
import { runStage1 } from '../stages/01-purchase.js'
import { runStage2 } from '../stages/02-refusal.js'
import { runStage3 } from '../stages/03-gate.js'
import { runStage4 } from '../stages/04-injection.js'
import { runStage5 } from '../stages/05-failure-recovery.js'
import { runStage6 } from '../stages/06-revocation.js'

let harness: DemoHarness | undefined

afterEach(async () => {
  if (harness) {
    await harness.close()
    harness = undefined
  }
})

afterAll(async () => {
  await closeStore()
})

describe('stage 1 — purchase (happy path)', () => {
  it('captures a ~₹3,200 in-stock purchase with the expected ledger trail', async () => {
    harness = await createHarness()
    const run = await runStage1(harness)

    expect(run.outcome.expectedTerminal).toBe('captured')
    expect(run.detail.pricePaise).toBeLessThanOrEqual(400_000)
    expect(run.outcome.ledgerEvents).toContain('verify_passed')
    expect(run.outcome.ledgerEvents).toContain('payment_captured')

    const row = harness.db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(run.detail.settlementId) as { state: string }
    expect(row.state).toBe('captured')
  })
})

describe('stage 2 — refusal (overspend)', () => {
  it('blocks an over-ceiling cart with AMOUNT_EXCEEDS_CEILING', async () => {
    harness = await createHarness()
    const run = await runStage2(harness)

    expect(run.detail.rejectReason).toBe('AMOUNT_EXCEEDS_CEILING')
    expect(run.outcome.ledgerEvents).toContain('verify_rejected')
    expect(run.outcome.ledgerEvents).not.toContain('payment_captured')

    const row = harness.db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(run.detail.settlementId) as { state: string }
    expect(row.state).toBe('rejected')
  })
})

describe('stage 3 — gate (human-in-the-loop)', () => {
  it('approves, rejects, and TTL-abandons above-threshold carts correctly', async () => {
    harness = await createHarness()
    const run = await runStage3(harness)

    expect(run.detail.approve.terminalState).toBe('captured')
    expect(run.detail.approve.events).toContain('approval_requested')
    expect(run.detail.approve.events).toContain('approval_granted')
    expect(run.detail.approve.events).toContain('payment_captured')

    expect(run.detail.reject.terminalState).toBe('rejected')
    expect(run.detail.reject.events).toContain('approval_rejected')

    expect(run.detail.ttl.terminalState).toBe('abandoned')
    expect(run.detail.ttl.events).toContain('approval_expired')
  })
})

describe('stage 4 — injection caught', () => {
  it('blocks the fooled brain’s forged cart with MERCHANT_NOT_IN_SCOPE', async () => {
    harness = await createHarness()
    const run = await runStage4(harness)

    expect(run.detail.rejectReason).toBe('MERCHANT_NOT_IN_SCOPE')
    expect(run.detail.attemptedMerchant).toBe('attacker-store')
    expect(run.outcome.ledgerEvents).toContain('verify_rejected')
    expect(run.outcome.ledgerEvents).not.toContain('payment_captured')
  })
})

describe('stage 5 — failure recovery', () => {
  it('falls back to a payment link, refunds a late capture on the dead path, retains one capture', async () => {
    harness = await createHarness()
    const run = await runStage5(harness)

    expect(run.detail.capturedAttemptCount).toBe(1)
    expect(run.detail.anomalyRefundCount).toBe(1)
    expect(run.detail.shortUrl).toMatch(/^https:\/\//)
    expect(run.outcome.ledgerEvents).toContain('payment_link_issued')
    expect(run.outcome.ledgerEvents).toContain('anomaly_refund_issued')
    expect(run.outcome.ledgerEvents).toContain('payment_captured')
    expect(run.outcome.ledgerEvents.filter((e) => e === 'payment_failed')).toHaveLength(3)

    const row = harness.db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(run.detail.settlementId) as { state: string }
    expect(row.state).toBe('captured')
  })
})

describe('stage 6 — revocation', () => {
  it('lets a prior purchase stand but blocks the next one with MANDATE_REVOKED', async () => {
    harness = await createHarness()
    const run = await runStage6(harness)

    expect(run.detail.firstStateAfterRevoke).toBe('captured')
    expect(run.detail.secondRejectReason).toBe('MANDATE_REVOKED')
    expect(run.outcome.ledgerEvents).toContain('verify_rejected')
  })
})
