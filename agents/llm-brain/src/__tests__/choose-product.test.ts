/** Unit tests for `chooseProduct` — the pure selection step `runLlmPurchase` calls
 * internally and that external callers (the facilitator's POST /agent/select) reuse
 * directly, without running a full purchase. See llm-brain.test.ts for the
 * full-purchase-flow coverage this step feeds into. */

import { describe, expect, it } from 'vitest'
import { chooseProduct } from '../llm-brain.js'
import { fakeChat, makeProduct, pickOf } from './fixtures.js'

const GOAL = { query: 'running shoes', ceiling_paise: 500_000 }

describe('chooseProduct — relevant pick honored', () => {
  it('returns the LLM-chosen product, its reason, and overridden:false when the pick is valid', async () => {
    const cheap = makeProduct({ id: 'sku-cheap', price_paise: 100_000 })
    const pricier = makeProduct({ id: 'sku-pricier', price_paise: 300_000 })

    const result = await chooseProduct({
      candidates: [cheap, pricier],
      goal: GOAL,
      chat: fakeChat(pickOf('sku-pricier', 'better cushioning for long runs')),
    })

    expect(result).toEqual({
      product: pricier,
      chosen_sku: 'sku-pricier',
      reason: 'better cushioning for long runs',
      overridden: false,
    })
  })

  it('defaults `log` to a no-op so callers outside runLlmPurchase never have to supply one', async () => {
    const only = makeProduct({ id: 'sku-only', price_paise: 100_000 })
    await expect(
      chooseProduct({ candidates: [only], goal: GOAL, chat: fakeChat(pickOf('sku-only')) }),
    ).resolves.toMatchObject({ chosen_sku: 'sku-only', overridden: false })
  })
})

describe('chooseProduct — guardrail fallback', () => {
  it('falls back to the cheapest in-stock match when the pick references an unknown sku', async () => {
    const cheap = makeProduct({ id: 'sku-real-cheap', price_paise: 150_000 })
    const pricier = makeProduct({ id: 'sku-real-pricier', price_paise: 250_000 })

    const result = await chooseProduct({
      candidates: [cheap, pricier],
      goal: GOAL,
      chat: fakeChat(pickOf('sku-does-not-exist', 'hallucinated pick')),
    })

    expect(result).toEqual({
      product: cheap,
      chosen_sku: 'sku-real-cheap',
      reason: 'hallucinated pick',
      overridden: true,
      override_reason: 'SKU_NOT_IN_CANDIDATES',
    })
  })

  it('falls back to the cheapest in-stock match when the pick is over the ceiling', async () => {
    const affordable = makeProduct({ id: 'sku-affordable', price_paise: 200_000 })
    const overCeiling = makeProduct({ id: 'sku-over-ceiling', price_paise: 900_000 })

    const result = await chooseProduct({
      candidates: [affordable, overCeiling],
      goal: GOAL,
      chat: fakeChat(pickOf('sku-over-ceiling', 'premium pick')),
    })

    expect(result.overridden).toBe(true)
    expect(result.override_reason).toBe('OVER_CEILING')
    expect(result.chosen_sku).toBe('sku-affordable')
  })

  it('falls back to the cheapest in-stock match when the pick is out of stock', async () => {
    const inStock = makeProduct({ id: 'sku-in-stock', price_paise: 220_000 })
    const outOfStock = makeProduct({
      id: 'sku-out-of-stock',
      price_paise: 180_000,
      availability: { status: 'out_of_stock' },
    })

    const result = await chooseProduct({
      candidates: [inStock, outOfStock],
      goal: GOAL,
      chat: fakeChat(pickOf('sku-out-of-stock')),
    })

    expect(result.overridden).toBe(true)
    expect(result.override_reason).toBe('OUT_OF_STOCK')
    expect(result.chosen_sku).toBe('sku-in-stock')
  })

  it('falls back when the chat client returns no chosen_sku at all (unparseable/empty content)', async () => {
    const only = makeProduct({ id: 'sku-solo', price_paise: 150_000 })

    const result = await chooseProduct({
      candidates: [only],
      goal: GOAL,
      chat: fakeChat({}),
    })

    expect(result).toEqual({
      product: only,
      chosen_sku: 'sku-solo',
      overridden: true,
      override_reason: 'NO_LLM_PICK',
    })
  })

  it('reports no product (no chosen_sku) when nothing is affordable and in stock', async () => {
    const onlyOutOfStock = makeProduct({
      id: 'sku-unavailable',
      price_paise: 100_000,
      availability: { status: 'out_of_stock' },
    })

    const result = await chooseProduct({
      candidates: [onlyOutOfStock],
      goal: GOAL,
      chat: fakeChat(pickOf('sku-unavailable')),
    })

    expect(result.product).toBeUndefined()
    expect(result.chosen_sku).toBeUndefined()
    expect(result.overridden).toBe(true)
    expect(result.override_reason).toBe('OUT_OF_STOCK')
  })

  it('invokes the optional `log` callback with the same guardrail_override shape runLlmPurchase relies on', async () => {
    const cheap = makeProduct({ id: 'sku-cheap', price_paise: 100_000 })
    const overrides: unknown[] = []

    await chooseProduct({
      candidates: [cheap],
      goal: GOAL,
      chat: fakeChat(pickOf('sku-missing', 'bad pick')),
      log: (step, data) => {
        if (step === 'guardrail_override') overrides.push(data)
      },
    })

    expect(overrides).toEqual([{ reason: 'SKU_NOT_IN_CANDIDATES', llm_chosen_sku: 'sku-missing' }])
  })
})
