import { describe, expect, it } from 'vitest'
import type { ChooseProductArgs } from '../../../../agents/llm-brain/src/index.js'
import { fakeScanResult, getJson, makeTestApp, postJson, TEST_ENV } from './http-helpers.js'

const DASHBOARD_HEADERS = { 'x-hundi-dashboard-token': TEST_ENV.DASHBOARD_TOKEN }
const LLM_ENV = { LLM_BASE_URL: 'https://llm.test/v1', LLM_API_KEY: 'key', LLM_MODEL: 'test-model' }

async function onboard(app: Parameters<typeof postJson>[0]) {
  await postJson(
    app,
    '/stores/onboard',
    { url: 'https://select-target.example' },
    DASHBOARD_HEADERS,
  )
}

const CATALOG = fakeScanResult({
  merchant_id: 'select-target-example',
  products: [
    {
      sku: 'sku-cheap',
      name: 'Toe Separator',
      description: '',
      price_paise: 34900,
      currency: 'INR',
      availability: 'in_stock',
      image: '',
      brand: '',
      url: 'https://select-target.example/p/cheap',
    },
    {
      sku: 'sku-goal-match',
      name: 'Adjustable Wedge Max Cushion',
      description: '',
      price_paise: 249900,
      currency: 'INR',
      availability: 'in_stock',
      image: '',
      brand: '',
      url: 'https://select-target.example/p/wedge',
    },
    {
      sku: 'sku-over-budget',
      name: 'Premium Recovery Boot',
      description: '',
      price_paise: 999900,
      currency: 'INR',
      availability: 'in_stock',
      image: '',
      brand: '',
      url: 'https://select-target.example/p/boot',
    },
  ],
})

describe('POST /agent/select', () => {
  it('rejects requests without the dashboard token', async () => {
    const { app } = makeTestApp({ scanStore: async () => CATALOG })
    await onboard(app)
    const res = await postJson(app, '/agent/select', {
      merchant_id: 'select-target-example',
      goal: 'Adjustable Wedge Max Cushion',
      ceiling_paise: 500000,
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, error: 'UNAUTHORIZED' })
  })

  it('with LLM env configured, delegates to the injected chooseProduct and reports via:"llm"', async () => {
    const calls: ChooseProductArgs[] = []
    const { app } = makeTestApp({
      scanStore: async () => CATALOG,
      env: LLM_ENV,
      chooseProduct: async (args) => {
        calls.push(args)
        const product = args.candidates.find((p) => p.id === 'sku-goal-match')
        if (!product) return { overridden: false }
        return { product, chosen_sku: product.id, reason: 'matches your goal', overridden: false }
      },
    })
    await onboard(app)

    const res = await postJson(
      app,
      '/agent/select',
      {
        merchant_id: 'select-target-example',
        goal: 'Adjustable Wedge Max Cushion',
        ceiling_paise: 500000,
      },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      chosen_sku: 'sku-goal-match',
      title: 'Adjustable Wedge Max Cushion',
      price_paise: 249900,
      merchant_id: 'select-target-example',
      reason: 'matches your goal',
      via: 'llm',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.goal).toEqual({ query: 'Adjustable Wedge Max Cushion', ceiling_paise: 500000 })
    expect(calls[0]?.candidates.map((p) => p.id).sort()).toEqual([
      'sku-cheap',
      'sku-goal-match',
      'sku-over-budget',
    ])
  })

  it('reports via:"fallback" when the injected chooseProduct overrides the LLM pick', async () => {
    const { app } = makeTestApp({
      scanStore: async () => CATALOG,
      env: LLM_ENV,
      chooseProduct: async (args) => {
        const product = args.candidates.find((p) => p.id === 'sku-cheap')
        if (!product) return { overridden: true, override_reason: 'SKU_NOT_IN_CANDIDATES' }
        return {
          product,
          chosen_sku: product.id,
          overridden: true,
          override_reason: 'SKU_NOT_IN_CANDIDATES',
        }
      },
    })
    await onboard(app)

    const res = await postJson(
      app,
      '/agent/select',
      { merchant_id: 'select-target-example', goal: 'anything', ceiling_paise: 500000 },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      ok: true,
      chosen_sku: 'sku-cheap',
      via: 'fallback',
      reason: expect.stringContaining('SKU_NOT_IN_CANDIDATES'),
    })
  })

  it('with no LLM env and no injected chooseProduct, picks cheapest in stock under the ceiling with via:"cheapest"', async () => {
    const { app } = makeTestApp({ scanStore: async () => CATALOG })
    await onboard(app)

    const res = await postJson(
      app,
      '/agent/select',
      {
        merchant_id: 'select-target-example',
        goal: 'Adjustable Wedge Max Cushion',
        ceiling_paise: 500000,
      },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      chosen_sku: 'sku-cheap',
      title: 'Toe Separator',
      price_paise: 34900,
      merchant_id: 'select-target-example',
      reason: 'LLM not configured; chose cheapest in budget',
      via: 'cheapest',
    })
  })

  it('returns NO_AFFORDABLE_PRODUCT when nothing in the catalog fits the ceiling', async () => {
    const { app } = makeTestApp({ scanStore: async () => CATALOG })
    await onboard(app)

    const res = await postJson(
      app,
      '/agent/select',
      { merchant_id: 'select-target-example', goal: 'anything', ceiling_paise: 100 },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, error: 'NO_AFFORDABLE_PRODUCT' })
  })

  it('returns NO_AFFORDABLE_PRODUCT for an unknown merchant rather than throwing', async () => {
    const { app } = makeTestApp()
    const res = await postJson(
      app,
      '/agent/select',
      { merchant_id: 'nope', goal: 'anything', ceiling_paise: 500000 },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, error: 'NO_AFFORDABLE_PRODUCT' })
  })

  it('poisoned:true appends the attacker listing to the candidates chooseProduct evaluates', async () => {
    const calls: ChooseProductArgs[] = []
    const { app } = makeTestApp({
      scanStore: async () => CATALOG,
      env: LLM_ENV,
      chooseProduct: async (args) => {
        calls.push(args)
        const product = args.candidates.find((p) => p.id === 'sku-cheap')
        if (!product) return { overridden: false }
        return { product, chosen_sku: product.id, overridden: false }
      },
    })
    await onboard(app)

    await postJson(
      app,
      '/agent/select',
      {
        merchant_id: 'select-target-example',
        goal: 'anything',
        ceiling_paise: 500000,
        poisoned: true,
      },
      DASHBOARD_HEADERS,
    )
    expect(calls[0]?.candidates.map((p) => p.id)).toContain('poison-attacker')
  })
})

describe('POST /agent/select — unauthenticated GET /catalog stays unaffected', () => {
  it('GET /catalog/:merchant_id remains public', async () => {
    const { app } = makeTestApp({ scanStore: async () => CATALOG })
    await onboard(app)
    const res = await getJson(app, '/catalog/select-target-example')
    expect(res.status).toBe(200)
  })
})
