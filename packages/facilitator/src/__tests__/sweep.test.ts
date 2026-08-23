import { describe, expect, it } from 'vitest'
import type { Executor } from '../executor.js'
import type { RazorpayPayment } from '../razorpay-client.js'
import { createSweep, DEFAULT_SWEEP_TTLS } from '../sweep.js'
import { makeFakeRazorpay } from './executor-helpers.js'
import { makeIntent } from './fixtures.js'
import { insertAttempt, insertMandate, insertSettlement, openTestDb } from './helpers.js'

const NOW = 10_000_000

function makeFakeSweepExecutor(): Pick<Executor, 'execute' | 'resumeSettling'> & {
  calls: string[]
  resumeCalls: string[]
} {
  const calls: string[] = []
  const resumeCalls: string[] = []
  return {
    calls,
    resumeCalls,
    execute(id: string) {
      calls.push(id)
    },
    resumeSettling(id: string) {
      resumeCalls.push(id)
    },
  }
}

function makeMandateWithExpiry(db: ReturnType<typeof openTestDb>, expiresAt: number): string {
  const { intent } = makeIntent({ overrides: { expires_at: expiresAt } })
  return insertMandate(db, { mandate_id: intent.mandateId, intent_json: JSON.stringify(intent) })
}

describe('sweep — stale checkout_driver attempt with no provider artifact', () => {
  it('fails the attempt directly (sweep never creates provider artifacts)', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, { state: 'settling' })
    const attemptId = insertAttempt(db, {
      settlement_id: settlementId,
      method: 'checkout_driver',
      state: 'initiated',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.attemptStaleMs / 1000) - 10,
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()

    expect(report.attemptsFailedNoArtifact).toBe(1)
    const attempt = db
      .prepare('SELECT state FROM settlement_attempts WHERE id = ?')
      .get(attemptId) as {
      state: string
    }
    expect(attempt.state).toBe('failed')
    const ledgerCount = (
      db
        .prepare(`SELECT COUNT(*) c FROM ledger_events WHERE event_type = 'payment_failed'`)
        .get() as {
        c: number
      }
    ).c
    expect(ledgerCount).toBe(1)

    // Idempotent: a second tick sees the attempt is no longer 'initiated' and skips it.
    const second = await sweep.runOnce()
    expect(second.attemptsFailedNoArtifact).toBe(0)
    const ledgerCountAfter = (
      db
        .prepare(`SELECT COUNT(*) c FROM ledger_events WHERE event_type = 'payment_failed'`)
        .get() as {
        c: number
      }
    ).c
    expect(ledgerCountAfter).toBe(1)
  })
})

describe('sweep — stale checkout_driver attempt with a provider order (poll + converge)', () => {
  it('converges via reconcileByAttempt when Razorpay reports captured', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, { state: 'settling' })
    const attemptId = insertAttempt(db, {
      settlement_id: settlementId,
      method: 'checkout_driver',
      state: 'initiated',
      provider_order_id: 'order-sweep-poll',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.attemptStaleMs / 1000) - 10,
    })
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments(): Promise<RazorpayPayment[]> {
        return [
          { id: 'pay-sweep-poll', order_id: 'order-sweep-poll', status: 'captured', amount: 1000 },
        ]
      },
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({ db, deps: { razorpay, executor, now: () => NOW } })

    const report = await sweep.runOnce()

    expect(report.attemptsPolled).toBe(1)
    const attempt = db
      .prepare('SELECT state FROM settlement_attempts WHERE id = ?')
      .get(attemptId) as {
      state: string
    }
    expect(attempt.state).toBe('captured')
  })
})

describe('sweep — stranded transients', () => {
  it('abandons a settlement stuck in created or verifying past the TTL', async () => {
    const db = openTestDb()
    const createdId = insertSettlement(db, {
      state: 'created',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.transientStaleMs / 1000) - 10,
    })
    const verifyingId = insertSettlement(db, {
      state: 'verifying',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.transientStaleMs / 1000) - 10,
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()

    expect(report.transientsAbandoned).toBe(2)
    for (const id of [createdId, verifyingId]) {
      const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(id) as {
        state: string
      }
      expect(row.state).toBe('abandoned')
    }
  })
})

describe('sweep — stale verified', () => {
  it('abandons a settlement that auto-verified but was never settled', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, {
      state: 'verified',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.verifiedStaleMs / 1000) - 10,
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()

    expect(report.verifiedAbandoned).toBe(1)
    const row = db
      .prepare('SELECT state, reject_reason FROM settlements WHERE id = ?')
      .get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('abandoned')
    const ledgerRow = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'settlement_abandoned' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string }
    expect(JSON.parse(ledgerRow.payload)).toMatchObject({ reason: 'verified_timeout' })
  })
})

describe('sweep — pending_approval past expiry', () => {
  it('abandons and ledgers approval_expired once the fixed TTL passes', async () => {
    const db = openTestDb()
    const mandateId = makeMandateWithExpiry(db, NOW + 1_000_000) // mandate itself far from expiry
    const settlementId = insertSettlement(db, {
      mandate_id: mandateId,
      state: 'pending_approval',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.approvalTtlMs / 1000) - 10,
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()

    expect(report.approvalsExpired).toBe(1)
    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('abandoned')
    const ledgerRow = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'approval_expired' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string }
    expect(JSON.parse(ledgerRow.payload)).toMatchObject({ reason: 'approval_timeout' })
  })

  it('does not fire before the TTL has elapsed', async () => {
    const db = openTestDb()
    const mandateId = makeMandateWithExpiry(db, NOW + 1_000_000)
    const settlementId = insertSettlement(db, {
      mandate_id: mandateId,
      state: 'pending_approval',
      agedAt: NOW - 5, // fresh
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()

    expect(report.approvalsExpired).toBe(0)
    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('pending_approval')
  })
})

describe('sweep — stale approved: re-kick then abandon after the kick budget', () => {
  it('re-kicks the executor and bumps kick_count on each stale tick, abandons after maxApprovedKicks', async () => {
    const db = openTestDb()
    const mandateId = makeMandateWithExpiry(db, NOW + 1_000_000)
    const settlementId = insertSettlement(db, {
      mandate_id: mandateId,
      state: 'approved',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.approvedStaleMs / 1000) - 10,
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    for (let i = 1; i <= DEFAULT_SWEEP_TTLS.maxApprovedKicks; i++) {
      const report = await sweep.runOnce()
      expect(report.approvedKicked).toBe(1)
      const row = db
        .prepare('SELECT state, kick_count FROM settlements WHERE id = ?')
        .get(settlementId) as {
        state: string
        kick_count: number
      }
      expect(row.state).toBe('approved')
      expect(row.kick_count).toBe(i)
    }
    expect(executor.calls.filter((id) => id === settlementId)).toHaveLength(
      DEFAULT_SWEEP_TTLS.maxApprovedKicks,
    )

    const final = await sweep.runOnce()
    expect(final.approvedAbandoned).toBe(1)
    expect(final.approvedKicked).toBe(0)
    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('abandoned')
    const ledgerRow = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'settlement_abandoned' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string }
    expect(JSON.parse(ledgerRow.payload)).toMatchObject({ reason: 'kick_limit_exceeded' })
  })

  it('abandons immediately with mandate_expired when the mandate itself expired, without spending a kick', async () => {
    const db = openTestDb()
    const mandateId = makeMandateWithExpiry(db, NOW - 1) // already expired
    const settlementId = insertSettlement(db, {
      mandate_id: mandateId,
      state: 'approved',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.approvedStaleMs / 1000) - 10,
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()

    expect(report.approvedAbandoned).toBe(1)
    expect(executor.calls).toHaveLength(0)
    const ledgerRow = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'settlement_abandoned' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string }
    expect(JSON.parse(ledgerRow.payload)).toMatchObject({ reason: 'mandate_expired' })
  })
})

describe('sweep — settling with no active attempt', () => {
  it('resumes the executor and ledgers reconciliation_flagged once, not once per tick', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, {
      state: 'settling',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.settlingNoAttemptStaleMs / 1000) - 10,
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const first = await sweep.runOnce()
    expect(first.settlingResumed).toBe(1)
    expect(executor.resumeCalls).toEqual([settlementId])
    const flaggedCountAfterFirst = (
      db
        .prepare(`SELECT COUNT(*) c FROM ledger_events WHERE event_type = 'reconciliation_flagged'`)
        .get() as { c: number }
    ).c
    expect(flaggedCountAfterFirst).toBe(1)

    const second = await sweep.runOnce()
    expect(second.settlingResumed).toBe(1) // still re-kicked — cheap, dedup'd by the executor itself
    expect(executor.resumeCalls).toEqual([settlementId, settlementId])
    const flaggedCountAfterSecond = (
      db
        .prepare(`SELECT COUNT(*) c FROM ledger_events WHERE event_type = 'reconciliation_flagged'`)
        .get() as { c: number }
    ).c
    expect(flaggedCountAfterSecond).toBe(1) // not duplicated
  })

  it('does not fire when there is a live attempt', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, {
      state: 'settling',
      agedAt: NOW - Math.floor(DEFAULT_SWEEP_TTLS.settlingNoAttemptStaleMs / 1000) - 10,
    })
    insertAttempt(db, {
      settlement_id: settlementId,
      method: 'checkout_driver',
      state: 'initiated',
    })
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()
    expect(report.settlingResumed).toBe(0)
    expect(executor.resumeCalls).toHaveLength(0)
  })
})

describe('sweep — stale idempotency-key locks', () => {
  it('clears a lock with no response so the original key can be reclaimed', async () => {
    const db = openTestDb()
    const cutoff = NOW - Math.floor(DEFAULT_SWEEP_TTLS.idempotencyLockStaleMs / 1000) - 10
    db.prepare(
      'INSERT INTO idempotency_keys (key, request_hash_hex, locked_at) VALUES (?, ?, ?)',
    ).run('stale-key', 'hash-1', cutoff)
    db.prepare(
      'INSERT INTO idempotency_keys (key, request_hash_hex, locked_at, response_status, response_body) VALUES (?, ?, ?, ?, ?)',
    ).run('completed-key', 'hash-2', cutoff, 200, '{}')

    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const report = await sweep.runOnce()

    expect(report.idempotencyLocksCleared).toBe(1)
    expect(
      db.prepare('SELECT 1 FROM idempotency_keys WHERE key = ?').get('stale-key'),
    ).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM idempotency_keys WHERE key = ?').get('completed-key'),
    ).toBeDefined()
  })
})

describe('sweep — overall idempotency', () => {
  it('running runOnce twice with nothing new to converge changes nothing on the second pass', async () => {
    const db = openTestDb()
    const executor = makeFakeSweepExecutor()
    const sweep = createSweep({
      db,
      deps: { razorpay: makeFakeRazorpay(), executor, now: () => NOW },
    })

    const first = await sweep.runOnce()
    const second = await sweep.runOnce()

    expect(first).toEqual(second)
    const ledgerCount = (db.prepare('SELECT COUNT(*) c FROM ledger_events').get() as { c: number })
      .c
    expect(ledgerCount).toBe(0)
  })
})
