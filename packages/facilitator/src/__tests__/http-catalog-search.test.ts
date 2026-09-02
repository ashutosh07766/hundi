import type { ScannedProduct } from '@hundi/cli/scanner'
import { describe, expect, it } from 'vitest'
import { fakeScanResult, getJson, makeTestApp, postJson, TEST_ENV } from './http-helpers.js'

const DASHBOARD_HEADERS = { 'x-hundi-dashboard-token': TEST_ENV.DASHBOARD_TOKEN }

function fakeProduct(overrides: Partial<ScannedProduct> = {}): ScannedProduct {
  return {
    sku: 'sku-1',
    name: 'Generic Product',
    description: 'A generic product.',
    price_paise: 100000,
    currency: 'INR',
    availability: 'in_stock',
    image: 'https://example.com/img.jpg',
    brand: 'Generic Brand',
    url: 'https://example.com/p/1',
    ...overrides,
  }
}

/** Drives POST /stores/onboard so the mocked `scanStore` (fixed per test) actually
 * populates `store_catalogs` — the URL itself is irrelevant since `scanStore` is
 * stubbed, but the round trip through onboarding is what exercises the real
 * upsert path the search route reads from. */
async function onboard(app: Parameters<typeof postJson>[0], merchantId: string): Promise<void> {
  await postJson(
    app,
    '/stores/onboard',
    { url: `https://${merchantId}.example` },
    DASHBOARD_HEADERS,
  )
}

describe('GET /catalog/search', () => {
  it('rejects a missing or empty q with INVALID_QUERY', async () => {
    const { app } = makeTestApp()

    const missing = await getJson(app, '/catalog/search')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ ok: false, error: 'INVALID_QUERY' })

    const empty = await getJson(app, '/catalog/search?q=%20%20')
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ ok: false, error: 'INVALID_QUERY' })
  })

  it('ranks a title match above a description-only match for the same query', async () => {
    const scan = fakeScanResult({
      merchant_id: 'store-a',
      products: [
        fakeProduct({
          sku: 'sku-title',
          name: 'Velocity Air Runner',
          description: 'Lightweight everyday trainer.',
          brand: 'Velocity Run',
        }),
        fakeProduct({
          sku: 'sku-desc',
          name: 'Cloudstep Recovery',
          description: 'Made with velocity foam technology.',
          brand: 'ArcRun',
        }),
      ],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-a')

    const res = await getJson(app, '/catalog/search?q=velocity')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: true; results: { id: string }[]; count: number }
    expect(json.count).toBe(2)
    expect(json.results.map((p) => p.id)).toEqual(['sku-title', 'sku-desc'])
  })

  it('drops products above max_price_paise', async () => {
    const scan = fakeScanResult({
      merchant_id: 'store-b',
      products: [
        fakeProduct({ sku: 'sku-cheap', name: 'Budget Widget', price_paise: 50000 }),
        fakeProduct({ sku: 'sku-pricey', name: 'Premium Widget', price_paise: 500000 }),
      ],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-b')

    const res = await getJson(app, '/catalog/search?q=widget&max_price_paise=100000')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: { id: string }[]; count: number }
    expect(json.count).toBe(1)
    expect(json.results[0]?.id).toBe('sku-cheap')
  })

  it('restricts to a single merchant when merchant_id is given', async () => {
    const scanA = fakeScanResult({
      merchant_id: 'store-c',
      products: [fakeProduct({ sku: 'sku-c-1', name: 'Trail Shoe' })],
    })
    const scanB = fakeScanResult({
      merchant_id: 'store-d',
      products: [fakeProduct({ sku: 'sku-d-1', name: 'Trail Shoe' })],
    })
    let call = 0
    const { app } = makeTestApp({
      scanStore: async () => {
        call += 1
        return call === 1 ? scanA : scanB
      },
    })
    await onboard(app, 'store-c')
    await onboard(app, 'store-d')

    const res = await getJson(app, '/catalog/search?q=trail&merchant_id=store-c')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: { id: string; merchant_id: string }[] }
    expect(json.results).toHaveLength(1)
    expect(json.results[0]).toMatchObject({ id: 'sku-c-1', merchant_id: 'store-c' })
  })

  it('filters to in-stock only when in_stock=true', async () => {
    const scan = fakeScanResult({
      merchant_id: 'store-e',
      products: [
        fakeProduct({ sku: 'sku-in', name: 'Trail Jacket', availability: 'in_stock' }),
        fakeProduct({ sku: 'sku-out', name: 'Trail Jacket XL', availability: 'out_of_stock' }),
      ],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-e')

    const all = await getJson(app, '/catalog/search?q=trail+jacket')
    expect(((await all.json()) as { count: number }).count).toBe(2)

    const inStockOnly = await getJson(app, '/catalog/search?q=trail+jacket&in_stock=true')
    const json = (await inStockOnly.json()) as { results: { id: string }[] }
    expect(json.results.map((p) => p.id)).toEqual(['sku-in'])
  })

  it('searches across every onboarded store when merchant_id is omitted', async () => {
    const scanA = fakeScanResult({
      merchant_id: 'store-f',
      products: [fakeProduct({ sku: 'sku-f-1', name: 'Kettle' })],
    })
    const scanB = fakeScanResult({
      merchant_id: 'store-g',
      products: [fakeProduct({ sku: 'sku-g-1', name: 'Kettle Pro' })],
    })
    let call = 0
    const { app } = makeTestApp({
      scanStore: async () => {
        call += 1
        return call === 1 ? scanA : scanB
      },
    })
    await onboard(app, 'store-f')
    await onboard(app, 'store-g')

    const res = await getJson(app, '/catalog/search?q=kettle')
    const json = (await res.json()) as { results: { merchant_id: string }[]; count: number }
    expect(json.count).toBe(2)
    expect(new Set(json.results.map((p) => p.merchant_id))).toEqual(new Set(['store-f', 'store-g']))
  })

  it('caps results at the requested limit and never exceeds the max of 100', async () => {
    const products = Array.from({ length: 30 }, (_, i) =>
      fakeProduct({ sku: `sku-${i}`, name: `Matchable Item ${i}` }),
    )
    const scan = fakeScanResult({ merchant_id: 'store-h', products })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-h')

    const res = await getJson(app, '/catalog/search?q=matchable&limit=5')
    const json = (await res.json()) as { count: number }
    expect(json.count).toBe(5)

    const overCapped = await getJson(app, '/catalog/search?q=matchable&limit=500')
    const overJson = (await overCapped.json()) as { count: number }
    expect(overJson.count).toBe(30)
  })

  it('rejects a non-numeric limit or max_price_paise', async () => {
    const { app } = makeTestApp()
    const badLimit = await getJson(app, '/catalog/search?q=x&limit=abc')
    expect(badLimit.status).toBe(400)
    expect(await badLimit.json()).toMatchObject({ ok: false, error: 'INVALID_LIMIT' })

    const badPrice = await getJson(app, '/catalog/search?q=x&max_price_paise=-5')
    expect(badPrice.status).toBe(400)
    expect(await badPrice.json()).toMatchObject({ ok: false, error: 'INVALID_MAX_PRICE' })
  })
})
