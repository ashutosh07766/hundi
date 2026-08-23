/**
 * The two-key separation-of-parties gate, tested end-to-end at the HTTP layer.
 *
 * This is the regression test for the C1 exploit: before the fix, the mandate's
 * registered credential was forced to equal `agent_pubkey_hex`, so the one key
 * the agent held verified the intent, the cart, AND approvals — the agent could
 * self-approve its own above-threshold payment, defeating the entire
 * human-in-the-loop guarantee.
 *
 * After the fix the human key is the registered credential (signs intent +
 * approvals + revocations) and the agent key is `agent_pubkey_hex` (signs carts
 * only). The agent can push an above-threshold cart into `pending_approval` but
 * structurally cannot approve it — only the human key can. These tests hold that
 * line.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { tx } from '../db/index.js'
import type { Executor } from '../executor.js'
import { appendLedger } from '../ledger.js'
import { transitionSettlement } from '../state-machine.js'
import { computeMandateCartHash } from '../verify-logic.js'
import { makeFakeRazorpay } from './executor-helpers.js'
import {
  credentialFor,
  makeCart,
  makeEd25519Keypair,
  makeIntent,
  signCanonical,
} from './fixtures.js'
import { openTestDb } from './helpers.js'
import { mintCeremonyToken, postJson, TEST_ENV } from './http-helpers.js'

type TestDb = ReturnType<typeof openTestDb>

/** Marks a settlement captured synchronously — the real Razorpay-backed executor
 * is proven elsewhere; here we only need `approved` to become `captured` so the
 * "human key can approve" arm reaches a genuine terminal capture. */
function makeCapturingExecutor(db: TestDb): Executor {
  return {
    execute(settlementId: string): void {
      tx(db, () => {
        transitionSettlement(db, settlementId, 'approved', 'settling')
        db.prepare(
          `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt)
           VALUES (?, ?, 's2s_api', 'captured', ?)`,
        ).run(randomUUID(), settlementId, randomUUID())
        transitionSettlement(db, settlementId, 'settling', 'captured')
        appendLedger(db, {
          event_type: 'payment_captured',
          settlement_id: settlementId,
          actor: 'executor:fake',
          payload: {},
        })
      })
    },
    resumeSettling(): void {},
  }
}

/** Registers a human-credentialed mandate whose agent key is a DISTINCT party,
 * then has the agent push an above-threshold cart into pending_approval. */
async function setupAgentGatedSettlement() {
  const db = openTestDb()
  const app = createApp({
    db,
    executor: makeCapturingExecutor(db),
    env: TEST_ENV,
    razorpay: makeFakeRazorpay(),
  })

  const human = makeEd25519Keypair()
  const agent = makeEd25519Keypair()
  expect(human.publicKeyHex).not.toBe(agent.publicKeyHex)

  // Human signs the intent; the intent attests the agent key. Registered
  // credential = the human key (NOT the agent key — that is the whole point).
  const { intent } = makeIntent({
    agent,
    human,
    overrides: { approval_threshold_paise: 200_000, ceiling_paise: 500_000 },
  })
  const ceremonyToken = await mintCeremonyToken(app)
  const reg = await postJson(app, '/mandates', {
    intent,
    credential: credentialFor(human),
    ceremonyToken,
  })
  expect(reg.status).toBe(201)

  // The agent builds and signs an above-threshold cart with its OWN key.
  const cart = makeCart({
    agent,
    intent,
    items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 300_000 }],
    overrides: { cartId: 'c1-exploit-cart' },
  })
  const createRes = await postJson(
    app,
    '/settlements',
    { intent, cart },
    { 'Idempotency-Key': 'idem-c1' },
  )
  const created = (await createRes.json()) as {
    ok: boolean
    settlement_id: string
    state: string
    reason?: string
  }
  expect(created.state, `unexpected reject reason: ${created.reason}`).toBe('pending_approval')

  const mandateCartHashHex = computeMandateCartHash(intent, cart)
  return { db, app, human, agent, settlementId: created.settlement_id, mandateCartHashHex }
}

describe('two-key separation — the C1 self-approval exploit is blocked', () => {
  it('rejects an approval signed by the AGENT key and leaves the settlement pending_approval', async () => {
    const { db, app, agent, settlementId, mandateCartHashHex } = await setupAgentGatedSettlement()

    // The agent holds only its cart-signing key. It signs the approval payload
    // with that key — internally well-formed, but it is not the registered
    // (human) credential the approvals route verifies against.
    const forgedSig = signCanonical(agent.privateKey, {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
    })

    const res = await postJson(app, '/approvals', {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
      sig: forgedSig,
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, error: 'APPROVAL_SIG_INVALID' })

    // Fail-closed: no state change, no capture.
    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('pending_approval')
    const captured = db
      .prepare(
        "SELECT COUNT(*) c FROM settlement_attempts WHERE settlement_id = ? AND state = 'captured'",
      )
      .get(settlementId) as { c: number }
    expect(captured.c).toBe(0)
  })

  it('accepts an approval signed by the HUMAN key and drives the settlement to captured', async () => {
    const { db, app, human, settlementId, mandateCartHashHex } = await setupAgentGatedSettlement()

    const humanSig = signCanonical(human.privateKey, {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
    })

    const res = await postJson(app, '/approvals', {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
      sig: humanSig,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      settlement_id: settlementId,
      state: 'approved',
    })

    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('captured')
  })
})

describe('two-key separation — revocation requires the human key', () => {
  it('rejects a revocation signed by the AGENT key but accepts the human key', async () => {
    const db = openTestDb()
    const app = createApp({
      db,
      executor: makeCapturingExecutor(db),
      env: TEST_ENV,
      razorpay: makeFakeRazorpay(),
    })

    const human = makeEd25519Keypair()
    const agent = makeEd25519Keypair()
    const { intent } = makeIntent({ agent, human })
    const ceremonyToken = await mintCeremonyToken(app)
    await postJson(app, '/mandates', { intent, credential: credentialFor(human), ceremonyToken })

    // Agent tries to revoke with its own key — the route verifies against the
    // registered (human) credential, so this fails.
    const agentSig = signCanonical(agent.privateKey, {
      mandateId: intent.mandateId,
      action: 'revoke',
    })
    const agentRes = await postJson(app, '/revoke', { mandateId: intent.mandateId, sig: agentSig })
    expect(agentRes.status).toBe(401)
    expect(await agentRes.json()).toMatchObject({ ok: false, error: 'REVOKE_SIG_INVALID' })

    const stillLive = db
      .prepare('SELECT revoked_at FROM mandates WHERE mandate_id = ?')
      .get(intent.mandateId) as { revoked_at: number | null }
    expect(stillLive.revoked_at).toBeNull()

    // The human key can revoke.
    const humanSig = signCanonical(human.privateKey, {
      mandateId: intent.mandateId,
      action: 'revoke',
    })
    const humanRes = await postJson(app, '/revoke', { mandateId: intent.mandateId, sig: humanSig })
    expect(humanRes.status).toBe(200)
    expect(await humanRes.json()).toMatchObject({ ok: true, mandateId: intent.mandateId })

    const revoked = db
      .prepare('SELECT revoked_at FROM mandates WHERE mandate_id = ?')
      .get(intent.mandateId) as { revoked_at: number | null }
    expect(revoked.revoked_at).not.toBeNull()
  })
})
