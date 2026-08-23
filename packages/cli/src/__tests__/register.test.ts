import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerMerchant } from '../register.js'
import type { ScanResult } from '../scanner.js'

const originalFetch = globalThis.fetch

const store: ScanResult = {
  merchant_id: 'shop-example-com',
  warnings: [],
  products: [
    {
      sku: 'sku-001',
      name: 'Velocity Runner',
      description: '',
      price_paise: 320000,
      currency: 'INR',
      availability: 'in_stock',
      image: '',
      brand: '',
      url: 'https://shop.example.com/products/velocity-runner',
    },
    {
      sku: 'sku-002',
      name: 'Cloudstep',
      description: '',
      price_paise: 380000,
      currency: 'INR',
      availability: 'out_of_stock',
      image: '',
      brand: '',
      url: 'https://shop.example.com/products/cloudstep',
    },
  ],
}

describe('registerMerchant', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('POSTs catalogPrices (sku -> paise) with the admin-token header', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await registerMerchant({
      facilitatorUrl: 'https://facilitator.example.com',
      adminToken: 'secret-token',
      store,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://facilitator.example.com/admin/merchants')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-hundi-admin-token']).toBe('secret-token')

    const body = JSON.parse(init.body as string)
    expect(body.merchant_id).toBe('shop-example-com')
    expect(body.config.catalogPrices).toEqual({ 'sku-001': 320000, 'sku-002': 380000 })
  })

  it('treats a 409 MERCHANT_EXISTS response as "already registered", not a throw', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'MERCHANT_EXISTS' }), { status: 409 }),
      )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await registerMerchant({
      facilitatorUrl: 'https://facilitator.example.com',
      adminToken: 'secret-token',
      store,
    })
    expect(result).toEqual({ ok: true, status: 'already_registered' })
  })

  it('throws with the response detail on other non-2xx statuses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('bad token', { status: 401 }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      registerMerchant({
        facilitatorUrl: 'https://facilitator.example.com',
        adminToken: 'wrong',
        store,
      }),
    ).rejects.toThrow(/401/)
  })
})
