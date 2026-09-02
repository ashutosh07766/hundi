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
 * populates `store_catalogs` — mirrors http-catalog-search.test.ts's helper of the
 * same name, exercising the real upsert path the upsell route reads from. */
async function onboard(app: Parameters<typeof postJson>[0], merchantId: string): Promise<void> {
  await postJson(
    app,
    '/stores/onboard',
    { url: `https://${merchantId}.example` },
    DASHBOARD_HEADERS,
  )
}

describe('GET /catalog/:merchant_id/upsell', () => {
  it('rejects a missing or empty sku with INVALID_SKU', async () => {
    const { app } = makeTestApp()

    const missing = await getJson(app, '/catalog/store-a/upsell')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ ok: false, error: 'INVALID_SKU' })

    const empty = await getJson(app, '/catalog/store-a/upsell?sku=%20')
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ ok: false, error: 'INVALID_SKU' })
  })

  it('404s CATALOG_NOT_FOUND for an unknown merchant', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/catalog/no-such-store/upsell?sku=sku-1')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'CATALOG_NOT_FOUND' })
  })

  it('404s SKU_NOT_FOUND for a sku absent from an onboarded catalog', async () => {
    const scan = fakeScanResult({
      merchant_id: 'store-a',
      products: [fakeProduct({ sku: 'sku-1' })],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-a')

    const res = await getJson(app, '/catalog/store-a/upsell?sku=no-such-sku')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'SKU_NOT_FOUND' })
  })

  it('ranks same-brand and shared-title-token complements above unrelated products, excluding the anchor sku and out-of-stock items', async () => {
    const scan = fakeScanResult({
      merchant_id: 'store-b',
      products: [
        fakeProduct({ sku: 'shoes', name: 'Trail Running Shoes', brand: 'Velocity Run' }),
        // Same brand, no shared title tokens — scores on brand alone.
        fakeProduct({ sku: 'brand-match', name: 'Recovery Sandals', brand: 'Velocity Run' }),
        // Shares "trail" + "running" tokens with the anchor title, different brand —
        // scores lower than the brand match (two token hits vs. one brand hit).
        fakeProduct({ sku: 'token-match', name: 'Trail Running Socks', brand: 'Other Brand' }),
        // Same brand, but out of stock — must be excluded even though it would
        // otherwise score on brand alone.
        fakeProduct({
          sku: 'oos-match',
          name: 'Insoles',
          brand: 'Velocity Run',
          availability: 'out_of_stock',
        }),
        // No brand or token overlap with the anchor — must be excluded (score 0).
        fakeProduct({ sku: 'unrelated', name: 'Kitchen Kettle', brand: 'Home Co' }),
      ],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-b')

    const res = await getJson(app, '/catalog/store-b/upsell?sku=shoes')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { sku: string; results: { id: string }[]; count: number }
    expect(json.sku).toBe('shoes')
    expect(json.results.map((p) => p.id)).toEqual(['brand-match', 'token-match'])
    expect(json.count).toBe(2)
  })

  it('honors limit, defaults to 4, and caps at 12', async () => {
    const products = [
      fakeProduct({ sku: 'anchor', name: 'Trail Running Shoes', brand: 'Velocity Run' }),
      ...Array.from({ length: 20 }, (_, i) =>
        fakeProduct({
          sku: `complement-${i}`,
          name: 'Trail Running Gear',
          brand: 'Velocity Run',
        }),
      ),
    ]
    const scan = fakeScanResult({ merchant_id: 'store-c', products })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-c')

    const defaultRes = await getJson(app, '/catalog/store-c/upsell?sku=anchor')
    expect(((await defaultRes.json()) as { count: number }).count).toBe(4)

    const limitedRes = await getJson(app, '/catalog/store-c/upsell?sku=anchor&limit=2')
    expect(((await limitedRes.json()) as { count: number }).count).toBe(2)

    const overCappedRes = await getJson(app, '/catalog/store-c/upsell?sku=anchor&limit=100')
    expect(((await overCappedRes.json()) as { count: number }).count).toBe(12)
  })

  it('rejects a non-numeric limit', async () => {
    const scan = fakeScanResult({
      merchant_id: 'store-d',
      products: [fakeProduct({ sku: 'sku-1' }), fakeProduct({ sku: 'sku-2' })],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await onboard(app, 'store-d')

    const res = await getJson(app, '/catalog/store-d/upsell?sku=sku-1&limit=abc')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: 'INVALID_LIMIT' })
  })
})
