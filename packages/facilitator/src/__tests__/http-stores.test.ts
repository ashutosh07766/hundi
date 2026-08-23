import type { ScanResult } from '@hundi/cli/scanner'
import { describe, expect, it } from 'vitest'
import { fakeScanResult, getJson, makeTestApp, postJson, TEST_ENV } from './http-helpers.js'

const DASHBOARD_HEADERS = { 'x-hundi-dashboard-token': TEST_ENV.DASHBOARD_TOKEN }

describe('POST /stores/onboard', () => {
  it('rejects requests without the dashboard token', async () => {
    const { app } = makeTestApp({ scanStore: async () => fakeScanResult() })
    const res = await postJson(app, '/stores/onboard', { url: 'https://example.com' })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'UNAUTHORIZED' })
  })

  it('scans, registers the merchant + catalog, and returns a sample', async () => {
    const scan = fakeScanResult({
      merchant_id: 'example-com',
      products: [
        {
          sku: 'sku-1',
          name: 'First Product',
          description: 'desc',
          price_paise: 100000,
          currency: 'INR',
          availability: 'in_stock',
          image: 'https://example.com/1.jpg',
          brand: 'Acme',
          url: 'https://example.com/p/1',
        },
        {
          sku: 'sku-2',
          name: 'Second Product',
          description: 'desc',
          price_paise: 200000,
          currency: 'INR',
          availability: 'out_of_stock',
          image: 'https://example.com/2.jpg',
          brand: 'Acme',
          url: 'https://example.com/p/2',
        },
      ],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })

    const res = await postJson(
      app,
      '/stores/onboard',
      { url: 'https://example.com' },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      ok: true,
      merchant_id: 'example-com',
      name: 'example.com',
      product_count: 2,
      sample: ['First Product', 'Second Product'],
    })

    const catalogRes = await getJson(app, '/catalog/example-com')
    expect(catalogRes.status).toBe(200)
    const products = (await catalogRes.json()) as Array<{ id: string; title: string }>
    expect(products).toHaveLength(2)
    expect(products.map((p) => p.id)).toEqual(['sku-1', 'sku-2'])

    const storesRes = await getJson(app, '/stores')
    const storesJson = (await storesRes.json()) as { ok: true; stores: unknown[] }
    expect(storesJson.stores).toEqual([
      {
        merchant_id: 'example-com',
        name: 'example.com',
        product_count: 2,
        source_url: 'https://example.com',
      },
    ])
  })

  it('reports NO_PRODUCTS and registers nothing when the scan yields zero usable products', async () => {
    const scan: ScanResult = {
      merchant_id: 'empty-com',
      warnings: ['no JSON-LD found'],
      products: [],
    }
    const { app } = makeTestApp({ scanStore: async () => scan })

    const res = await postJson(
      app,
      '/stores/onboard',
      { url: 'https://empty.com' },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'NO_PRODUCTS' })

    const storesRes = await getJson(app, '/stores')
    const storesJson = (await storesRes.json()) as { stores: unknown[] }
    expect(storesJson.stores).toEqual([])
  })

  it('filters out structurally invalid products before counting them as usable', async () => {
    const scan = fakeScanResult({
      merchant_id: 'partial-com',
      products: [
        {
          sku: 'sku-ok',
          name: 'Valid Product',
          description: '',
          price_paise: 50000,
          currency: 'INR',
          availability: 'in_stock',
          image: '',
          brand: '',
          url: 'https://partial.com/p/ok',
        },
        {
          sku: 'sku-bad',
          name: 'Zero Price Product',
          description: '',
          price_paise: 0,
          currency: 'INR',
          availability: 'in_stock',
          image: '',
          brand: '',
          url: 'https://partial.com/p/bad',
        },
      ],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })

    const res = await postJson(
      app,
      '/stores/onboard',
      { url: 'https://partial.com' },
      DASHBOARD_HEADERS,
    )
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, product_count: 1, sample: ['Valid Product'] })
  })

  it('reports SCAN_FAILED without registering anything when the scanner throws', async () => {
    const { app } = makeTestApp({
      scanStore: async () => {
        throw new Error('refusing to fetch private/loopback address')
      },
    })

    const res = await postJson(
      app,
      '/stores/onboard',
      { url: 'http://127.0.0.1' },
      DASHBOARD_HEADERS,
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      ok: false,
      error: 'SCAN_FAILED',
      detail: expect.stringContaining('loopback'),
    })

    const storesRes = await getJson(app, '/stores')
    const storesJson = (await storesRes.json()) as { stores: unknown[] }
    expect(storesJson.stores).toEqual([])
  })

  it('re-onboarding the same store upserts rather than 409ing', async () => {
    let call = 0
    const { app } = makeTestApp({
      scanStore: async () => {
        call += 1
        return fakeScanResult({
          merchant_id: 'reonboard-com',
          products: [
            {
              sku: 'sku-1',
              name: call === 1 ? 'Old Name' : 'New Name',
              description: '',
              price_paise: call === 1 ? 100000 : 150000,
              currency: 'INR',
              availability: 'in_stock',
              image: '',
              brand: '',
              url: 'https://reonboard.com/p/1',
            },
          ],
        })
      },
    })

    const first = await postJson(
      app,
      '/stores/onboard',
      { url: 'https://reonboard.com' },
      DASHBOARD_HEADERS,
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, product_count: 1 })

    const second = await postJson(
      app,
      '/stores/onboard',
      { url: 'https://reonboard.com' },
      DASHBOARD_HEADERS,
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ ok: true, product_count: 1 })

    const catalogRes = await getJson(app, '/catalog/reonboard-com')
    const products = (await catalogRes.json()) as Array<{ title: string; price_paise: number }>
    expect(products).toEqual([expect.objectContaining({ title: 'New Name', price_paise: 150000 })])

    const storesRes = await getJson(app, '/stores')
    const storesJson = (await storesRes.json()) as { stores: unknown[] }
    expect(storesJson.stores).toHaveLength(1)
  })
})

describe('GET /catalog/:merchant_id', () => {
  it('returns CATALOG_NOT_FOUND for an unknown merchant', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/catalog/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'CATALOG_NOT_FOUND' })
  })

  it('?poisoned=1 appends a synthetic attacker listing priced at the catalog minimum', async () => {
    const scan = fakeScanResult({
      merchant_id: 'poison-target-com',
      products: [
        {
          sku: 'sku-cheap',
          name: 'Cheap Item',
          description: '',
          price_paise: 50000,
          currency: 'INR',
          availability: 'in_stock',
          image: '',
          brand: '',
          url: 'https://poison-target.com/p/cheap',
        },
        {
          sku: 'sku-pricey',
          name: 'Pricey Item',
          description: '',
          price_paise: 900000,
          currency: 'INR',
          availability: 'in_stock',
          image: '',
          brand: '',
          url: 'https://poison-target.com/p/pricey',
        },
      ],
    })
    const { app } = makeTestApp({ scanStore: async () => scan })
    await postJson(app, '/stores/onboard', { url: 'https://poison-target.com' }, DASHBOARD_HEADERS)

    const res = await getJson(app, '/catalog/poison-target-com?poisoned=1')
    expect(res.status).toBe(200)
    const products = (await res.json()) as Array<{
      id: string
      merchant_id: string
      price_paise: number
      injectedPayload?: { merchant_id: string; price_paise: number }
    }>
    expect(products).toHaveLength(3)
    const poison = products.find((p) => p.id === 'poison-attacker')
    expect(poison).toMatchObject({
      merchant_id: 'attacker-store',
      price_paise: 50000,
      injectedPayload: { merchant_id: 'attacker-store', price_paise: 50000 },
    })
  })
})

describe('GET /stores', () => {
  it('returns an empty list when nothing has been onboarded', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/stores')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stores: [] })
  })
})
