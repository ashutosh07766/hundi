import { describe, expect, it } from 'vitest'
import { computeMandateCartHash } from '../verify-logic.js'
import { credentialFor, makeCart, makeIntent, signCanonical } from './fixtures.js'
import { makeTestApp, postJson, registerMandate } from './http-helpers.js'

/** Registers a mandate and creates an above-threshold settlement, landing it in
 * pending_approval — the starting point every approvals test needs. */
async function setupPendingApprovalSettlement() {
  const harness = makeTestApp()
  const { app } = harness
  const { intent, agent } = makeIntent()
  await registerMandate(app, intent, credentialFor(agent))
  const cart = makeCart({
    agent,
    intent,
    items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 300_000 }],
    overrides: { cartId: 'approvals-cart' },
  })

  const res = await postJson(
    app,
    '/settlements',
    { intent, cart },
    { 'Idempotency-Key': 'idem-approvals' },
  )
  const json = (await res.json()) as { settlement_id: string; state: string }
  const mandateCartHashHex = computeMandateCartHash(intent, cart)

  return { ...harness, intent, agent, cart, settlementId: json.settlement_id, mandateCartHashHex }
}

describe('POST /approvals', () => {
  it('transitions pending_approval -> approved on a valid signature and kicks the executor', async () => {
    const { app, db, executor, agent, settlementId, mandateCartHashHex } =
      await setupPendingApprovalSettlement()

    const sig = signCanonical(agent.privateKey, {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
    })

    const res = await postJson(app, '/approvals', {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
      sig,
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, settlement_id: settlementId, state: 'approved' })
    expect(executor.calls).toEqual([settlementId])

    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('approved')
  })

  it('rejects a bad signature with 401 APPROVAL_SIG_INVALID and leaves the settlement untouched', async () => {
    const { app, db, executor, settlementId, mandateCartHashHex } =
      await setupPendingApprovalSettlement()

    const res = await postJson(app, '/approvals', {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
      sig: { type: 'ed25519', signature_hex: '00'.repeat(64) },
    })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'APPROVAL_SIG_INVALID' })
    expect(executor.calls).toEqual([])

    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('pending_approval')
  })

  it('rejects a second decision on the same settlement with 409 ALREADY_DECIDED', async () => {
    const { app, agent, settlementId, mandateCartHashHex } = await setupPendingApprovalSettlement()

    const firstSig = signCanonical(agent.privateKey, {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
    })
    const first = await postJson(app, '/approvals', {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'approved',
      sig: firstSig,
    })
    expect(first.status).toBe(200)

    const secondSig = signCanonical(agent.privateKey, {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'rejected',
    })
    const second = await postJson(app, '/approvals', {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: 'rejected',
      sig: secondSig,
    })
    expect(second.status).toBe(409)
    const json = await second.json()
    expect(json).toMatchObject({ ok: false, error: 'ALREADY_DECIDED' })
  })

  it('rejects a mandate_cart_hash_hex that does not match the stored intent+cart', async () => {
    const { app, db, agent, settlementId } = await setupPendingApprovalSettlement()
    const wrongHash = '00'.repeat(32)

    // The signature is internally valid — signed over the wrong hash — but the recomputed
    // hash from the stored intent+cart won't match it, so this must not be trusted.
    const sig = signCanonical(agent.privateKey, {
      settlement_id: settlementId,
      mandate_cart_hash_hex: wrongHash,
      decision: 'approved',
    })

    const res = await postJson(app, '/approvals', {
      settlement_id: settlementId,
      mandate_cart_hash_hex: wrongHash,
      decision: 'approved',
      sig,
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'CART_HASH_MISMATCH' })

    const row = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
      state: string
    }
    expect(row.state).toBe('pending_approval')
  })
})
