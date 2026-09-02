import type { CanonicalValue } from '@hundi/core'
import { canonicalJson, sha256Hex } from '@hundi/core'
import { describe, expect, it } from 'vitest'
import { transitionSettlement } from '../state-machine.js'
import { credentialFor, makeCart, makeIntent } from './fixtures.js'
import { getJson, makeTestApp, postJson, registerMandate, TEST_ENV } from './http-helpers.js'

describe('POST /settlements — unregistered mandate', () => {
  it('rejects with MANDATE_UNKNOWN when the intent was never registered', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })

    // settlements.mandate_id is a real FK — an unregistered mandate can never back a
    // settlement row, so this fails before a row (or a settlement_id) ever exists.
    const res = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'k-unregistered' },
    )
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'MANDATE_UNKNOWN' })
  })
})

describe('POST /settlements — idempotency', () => {
  it('replays a byte-identical response for the same key + same body, with no second row', async () => {
    const { app, db } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cart = makeCart({ agent, intent, overrides: { cartId: 'idem-cart-1' } })

    const first = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-key-1' },
    )
    const firstText = await first.text()

    const second = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-key-1' },
    )
    const secondText = await second.text()

    expect(second.status).toBe(first.status)
    expect(secondText).toBe(firstText)

    const count = db.prepare('SELECT COUNT(*) AS c FROM settlements').get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('rejects the same key with a different body with 409 KEY_REUSED', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cartA = makeCart({ agent, intent, overrides: { cartId: 'reuse-cart-a' } })
    const cartB = makeCart({ agent, intent, overrides: { cartId: 'reuse-cart-b' } })

    const first = await postJson(
      app,
      '/settlements',
      { intent, cart: cartA },
      { 'Idempotency-Key': 'idem-key-2' },
    )
    expect(first.status).toBe(202)

    const second = await postJson(
      app,
      '/settlements',
      { intent, cart: cartB },
      { 'Idempotency-Key': 'idem-key-2' },
    )
    expect(second.status).toBe(409)
    const json = await second.json()
    expect(json).toMatchObject({ ok: false, error: 'KEY_REUSED' })
  })

  it('returns 409 IN_FLIGHT for a key that is locked but not yet completed', async () => {
    const { app, db } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cart = makeCart({ agent, intent, overrides: { cartId: 'in-flight-cart' } })

    // Simulates the window between a concurrent request's claim (INSERT) and its
    // completion (UPDATE) — see idempotency.ts. The request-hash must match exactly
    // what the route computes: sha256Hex(canonicalJson({ intent, cart })).
    const requestHashHex = sha256Hex(canonicalJson({ intent, cart } as unknown as CanonicalValue))
    db.prepare(
      'INSERT INTO idempotency_keys (key, request_hash_hex, locked_at) VALUES (?, ?, unixepoch())',
    ).run('idem-key-3', requestHashHex)

    const res = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-key-3' },
    )
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'IN_FLIGHT' })
  })

  it('rejects requests with no Idempotency-Key header', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cart = makeCart({ agent, intent })

    const res = await postJson(app, '/settlements', { intent, cart })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'IDEMPOTENCY_KEY_REQUIRED' })
  })
})

describe('POST /settlements — approval routing', () => {
  it('auto-approves a below-threshold cart and kicks the executor exactly once', async () => {
    const { app, executor } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    // approval_threshold_paise is 200_000; this cart totals well under it.
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 50_000 }],
      overrides: { cartId: 'below-threshold-cart' },
    })

    const res = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-below' },
    )
    expect(res.status).toBe(202)
    const json = (await res.json()) as { ok: boolean; settlement_id: string; state: string }
    expect(json.state).toBe('approved')
    expect(executor.calls).toEqual([json.settlement_id])
  })

  it('parks an above-threshold cart as pending_approval without kicking the executor', async () => {
    const { app, executor } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    // approval_threshold_paise is 200_000, ceiling_paise is 500_000; this cart is between them.
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 300_000 }],
      overrides: { cartId: 'above-threshold-cart' },
    })

    const res = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-above' },
    )
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, state: 'pending_approval' })
    expect(executor.calls).toEqual([])
  })
})

describe('POST /settlements — allowance and cart-hash constraints', () => {
  it('rejects a second live settlement for the same mandate with 409 ALLOWANCE_RESERVED', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cart1 = makeCart({ agent, intent, overrides: { cartId: 'live-cart-1' } })
    const cart2 = makeCart({ agent, intent, overrides: { cartId: 'live-cart-2' } })

    const first = await postJson(
      app,
      '/settlements',
      { intent, cart: cart1 },
      { 'Idempotency-Key': 'idem-live-1' },
    )
    expect(first.status).toBe(202)

    const second = await postJson(
      app,
      '/settlements',
      { intent, cart: cart2 },
      { 'Idempotency-Key': 'idem-live-2' },
    )
    expect(second.status).toBe(409)
    const json = await second.json()
    expect(json).toMatchObject({ ok: false, error: 'ALLOWANCE_RESERVED' })
  })

  it('allows resubmitting the same cart once the first settlement has failed', async () => {
    const { app, db } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 300_000 }],
      overrides: { cartId: 'retry-cart' },
    })

    const first = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-retry-1' },
    )
    expect(first.status).toBe(202)
    const firstJson = (await first.json()) as { settlement_id: string; state: string }
    expect(firstJson.state).toBe('pending_approval')

    // Drive the settlement to a terminal 'failed' state out of band — frees both the
    // one_live_settlement_per_mandate and one_settlement_per_cart partial indexes.
    transitionSettlement(db, firstJson.settlement_id, 'pending_approval', 'approved')
    transitionSettlement(db, firstJson.settlement_id, 'approved', 'settling')
    transitionSettlement(db, firstJson.settlement_id, 'settling', 'failed')

    const second = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-retry-2' },
    )
    expect(second.status).toBe(202)
    const secondJson = await second.json()
    expect(secondJson).toMatchObject({ ok: true, state: 'pending_approval' })
  })
})

describe('POST /settlements — catalog price check', () => {
  it('rejects with PRICE_MISMATCH when the registered merchant catalog price differs', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    const adminRes = await postJson(
      app,
      '/admin/merchants',
      {
        merchant_id: 'merchant-1',
        name: 'Merchant One',
        config: { catalogPrices: { 'sku-1': 999 } },
      },
      { 'x-hundi-admin-token': TEST_ENV.ADMIN_TOKEN },
    )
    expect(adminRes.status).toBe(201)

    const cart = makeCart({ agent, intent, overrides: { cartId: 'price-mismatch-cart' } })
    const res = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-price' },
    )
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, state: 'rejected', reason: 'PRICE_MISMATCH' })
  })
})

describe('POST /settlements — variant carts survive ingest', () => {
  it('preserves variant_id so a signed variant cart verifies (regression: SIG_INVALID_CART)', async () => {
    const { app, db } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    // Matching catalog price so the only check that could reject this cart is the
    // signature — isolating the regression this test guards.
    const adminRes = await postJson(
      app,
      '/admin/merchants',
      {
        merchant_id: 'merchant-1',
        name: 'Merchant One',
        config: { catalogPrices: { 'sku-1': 100_000 } },
      },
      { 'x-hundi-admin-token': TEST_ENV.ADMIN_TOKEN },
    )
    expect(adminRes.status).toBe(201)

    const cart = makeCart({
      agent,
      intent,
      items: [
        {
          sku: 'sku-1',
          qty: 1,
          unit_price_paise: 100_000,
          variant_id: 'v-11uk',
          variant_label: 'Black / 11UK',
        },
      ],
      overrides: { cartId: 'variant-cart' },
    })
    const res = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-variant' },
    )

    expect(res.status).toBe(202)
    const json = await res.json()
    // The bug: the ingest schema stripped variant_id, so the recomputed signing
    // bytes no longer matched the agent's signature and this rejected with
    // SIG_INVALID_CART. The signed variant cart must get past verification.
    expect(json).not.toMatchObject({ state: 'rejected', reason: 'SIG_INVALID_CART' })

    // And the chosen variant is preserved in the stored cart, so the record carries the size.
    const row = db.prepare('SELECT cart_json FROM settlements ORDER BY rowid DESC LIMIT 1').get() as
      | { cart_json: string }
      | undefined
    expect(row).toBeDefined()
    const storedCart = JSON.parse((row as { cart_json: string }).cart_json)
    expect(storedCart.items[0]).toMatchObject({
      variant_id: 'v-11uk',
      variant_label: 'Black / 11UK',
    })
  })
})

describe('POST /settlements — cumulative wallet cap', () => {
  it('measures prior captured spend against the ceiling, and a mandate stays active with budget left', async () => {
    const { app, db } = makeTestApp()
    // Ceiling ₹3,000; threshold high so nothing pauses for approval.
    const { intent, agent } = makeIntent({
      overrides: { ceiling_paise: 300_000, approval_threshold_paise: 300_000 },
    })
    await registerMandate(app, intent, credentialFor(agent))

    const adminRes = await postJson(
      app,
      '/admin/merchants',
      {
        merchant_id: 'merchant-1',
        name: 'Merchant One',
        config: { catalogPrices: { 'sku-1': 100_000 } },
      },
      { 'x-hundi-admin-token': TEST_ENV.ADMIN_TOKEN },
    )
    expect(adminRes.status).toBe(201)

    // ₹2,000 already captured under this mandate (spent 200_000, remaining 100_000).
    db.prepare(
      `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id, state)
       VALUES ('prior-capture', ?, '{}', 'prior-hash', 200000, 'merchant-1', 'captured')`,
    ).run(intent.mandateId)

    // A ₹2,000 cart would push cumulative spend to 400_000 > ceiling → rejected.
    // Posted first, while no settlement is live, so it reaches the budget check
    // (a live settlement would instead trip one_live_settlement_per_mandate). A
    // rejected settlement is terminal, so it holds no live lock afterward.
    const overCart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 2, unit_price_paise: 100_000 }],
      overrides: { cartId: 'over-cart' },
    })
    const overRes = await postJson(
      app,
      '/settlements',
      { intent, cart: overCart },
      { 'Idempotency-Key': 'idem-over' },
    )
    expect(overRes.status).toBe(202)
    expect(await overRes.json()).toMatchObject({
      ok: true,
      state: 'rejected',
      reason: 'AMOUNT_EXCEEDS_CEILING',
    })

    // A ₹1,000 cart fits exactly (200_000 + 100_000 = ceiling) → not rejected for budget.
    const fitCart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 100_000 }],
      overrides: { cartId: 'fits-cart' },
    })
    const fitRes = await postJson(
      app,
      '/settlements',
      { intent, cart: fitCart },
      { 'Idempotency-Key': 'idem-fit' },
    )
    expect(fitRes.status).toBe(202)
    expect(await fitRes.json()).not.toMatchObject({
      state: 'rejected',
      reason: 'AMOUNT_EXCEEDS_CEILING',
    })

    // The mandate is NOT consumed by the prior capture — still active, ₹1,000 left.
    const listed = (await (await getJson(app, '/mandates')).json()) as {
      mandates: { mandate_id: string; remaining_paise: number; state: string }[]
    }
    const row = listed.mandates.find((m) => m.mandate_id === intent.mandateId)
    expect(row).toMatchObject({ remaining_paise: 100_000, state: 'active' })
  })
})

describe('POST /settlements — per-merchant sub-ceiling', () => {
  it('rejects MERCHANT_LIMIT_EXCEEDED when merchant spend + cart exceeds the sub-ceiling, even under the global ceiling', async () => {
    const { app, db } = makeTestApp()
    // Global ceiling ₹5,000 leaves plenty of room, but merchant-1 is capped at ₹1,500.
    const { intent, agent } = makeIntent({
      overrides: {
        ceiling_paise: 500_000,
        per_merchant_ceiling_paise: { 'merchant-1': 150_000 },
      },
    })
    await registerMandate(app, intent, credentialFor(agent))

    const adminRes = await postJson(
      app,
      '/admin/merchants',
      {
        merchant_id: 'merchant-1',
        name: 'Merchant One',
        config: { catalogPrices: { 'sku-1': 100_000 } },
      },
      { 'x-hundi-admin-token': TEST_ENV.ADMIN_TOKEN },
    )
    expect(adminRes.status).toBe(201)

    // ₹1,000 already captured at merchant-1 → merchant spend 100_000, limit 150_000.
    db.prepare(
      `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id, state)
       VALUES ('m1-capture', ?, '{}', 'm1-hash', 100000, 'merchant-1', 'captured')`,
    ).run(intent.mandateId)

    // A ₹1,000 cart would bring merchant-1 spend to ₹2,000 > ₹1,500 → rejected,
    // even though global spend (₹2,000) is far under the ₹5,000 ceiling.
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 100_000 }],
      overrides: { cartId: 'm1-over' },
    })
    const res = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-m1' },
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      ok: true,
      state: 'rejected',
      reason: 'MERCHANT_LIMIT_EXCEEDED',
    })
  })
})
