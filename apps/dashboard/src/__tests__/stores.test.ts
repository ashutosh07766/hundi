import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../lib/api.js'
import { listStores, onboardStore } from '../lib/stores.js'

const FACILITATOR_URL = 'http://127.0.0.1:8790'

describe('onboardStore', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = undefined as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('POSTs the url with the dashboard token header and returns the onboarding summary', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify({
          ok: true,
          merchant_id: 'example-com',
          name: 'example.com',
          product_count: 3,
          sample: ['A', 'B', 'C'],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await onboardStore(FACILITATOR_URL, 'dash-token', 'https://example.com')

    expect(result).toEqual({
      ok: true,
      merchant_id: 'example-com',
      name: 'example.com',
      product_count: 3,
      sample: ['A', 'B', 'C'],
    })
    expect(calls[0]?.url).toBe(`${FACILITATOR_URL}/stores/onboard`)
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-hundi-dashboard-token']).toBe('dash-token')
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ url: 'https://example.com' })
  })

  it('returns a NO_PRODUCTS outcome without throwing (a genuine scan result, not a request failure)', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: 'NO_PRODUCTS',
          detail: 'store has no usable schema.org product markup',
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const result = await onboardStore(FACILITATOR_URL, 'dash-token', 'https://empty.com')
    expect(result).toEqual({
      ok: false,
      error: 'NO_PRODUCTS',
      detail: 'store has no usable schema.org product markup',
    })
  })

  it('throws ApiError on a non-2xx response (e.g. bad dashboard token)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }), {
        status: 401,
      })) as unknown as typeof fetch

    await expect(
      onboardStore(FACILITATOR_URL, 'wrong-token', 'https://example.com'),
    ).rejects.toThrow(ApiError)
  })

  it('throws ApiError on a network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch

    await expect(
      onboardStore(FACILITATOR_URL, 'dash-token', 'https://example.com'),
    ).rejects.toThrow(ApiError)
  })
})

describe('listStores', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = undefined as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('GETs /stores and returns the list', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      return new Response(
        JSON.stringify({
          ok: true,
          stores: [
            {
              merchant_id: 'demo-store-1',
              name: 'Hundi Demo Store',
              product_count: 20,
              source_url: 'http://127.0.0.1:8791',
            },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await listStores(FACILITATOR_URL)
    expect(calls[0]).toBe(`${FACILITATOR_URL}/stores`)
    expect(result).toEqual([
      {
        merchant_id: 'demo-store-1',
        name: 'Hundi Demo Store',
        product_count: 20,
        source_url: 'http://127.0.0.1:8791',
      },
    ])
  })

  it('throws ApiError when the server responds ok:false', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' }), {
        status: 500,
      })) as unknown as typeof fetch

    await expect(listStores(FACILITATOR_URL)).rejects.toThrow(ApiError)
  })
})
