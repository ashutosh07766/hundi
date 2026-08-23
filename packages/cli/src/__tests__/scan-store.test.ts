import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scanStore } from '../scanner.js'

const originalFetch = globalThis.fetch
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]

function html(body: string): string {
  return `<html><body>${body}</body></html>`
}

function jsonLd(payload: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(payload)}</script>`
}

describe('scanStore', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('follows same-origin product links from an index page and merges results', async () => {
    const pages: Record<string, string> = {
      'https://shop.example.com/': html(`
        <a href="/products/a">A</a>
        <a href="/products/b">B</a>
      `),
      'https://shop.example.com/products/a': html(
        jsonLd({
          '@type': 'Product',
          name: 'Product A',
          sku: 'sku-a',
          offers: { price: '10.00', priceCurrency: 'INR', availability: 'InStock' },
        }),
      ),
      'https://shop.example.com/products/b': html(
        jsonLd({
          '@type': 'Product',
          name: 'Product B',
          sku: 'sku-b',
          offers: { price: '20.00', priceCurrency: 'INR', availability: 'OutOfStock' },
        }),
      ),
    }

    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      const body = pages[url]
      if (!body) return new Response('not found', { status: 404 })
      return new Response(body, { status: 200 })
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await scanStore('https://shop.example.com/', { resolver: publicResolver })

    expect(result.merchant_id).toBe('shop-example-com')
    expect(result.products.map((p) => p.sku).sort()).toEqual(['sku-a', 'sku-b'])
    expect(result.products.find((p) => p.sku === 'sku-b')?.availability).toBe('out_of_stock')
  })

  it('records a per-link failure as a warning instead of aborting the whole scan', async () => {
    const pages: Record<string, string> = {
      'https://shop.example.com/': html(`
        <a href="/products/a">A</a>
        <a href="/products/broken">Broken</a>
      `),
      'https://shop.example.com/products/a': html(
        jsonLd({
          '@type': 'Product',
          name: 'Product A',
          sku: 'sku-a',
          offers: { price: '10.00', priceCurrency: 'INR', availability: 'InStock' },
        }),
      ),
    }

    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      const body = pages[url]
      if (!body) return new Response('server error', { status: 500 })
      return new Response(body, { status: 200 })
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await scanStore('https://shop.example.com/', { resolver: publicResolver })

    expect(result.products.map((p) => p.sku)).toEqual(['sku-a'])
    expect(result.warnings.some((w) => w.includes('products/broken'))).toBe(true)
  })

  it('caps link-sampling at maxProductPages', async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/products/${i}">${i}</a>`).join('')
    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url === 'https://shop.example.com/') return new Response(html(links), { status: 200 })
      const id = url.split('/').pop()
      return new Response(
        html(
          jsonLd({
            '@type': 'Product',
            name: `Product ${id}`,
            sku: `sku-${id}`,
            offers: { price: '10.00', priceCurrency: 'INR', availability: 'InStock' },
          }),
        ),
        { status: 200 },
      )
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await scanStore('https://shop.example.com/', {
      resolver: publicResolver,
      maxProductPages: 5,
    })

    // 1 fetch for the index page + 5 capped product-page fetches.
    expect(mockFetch).toHaveBeenCalledTimes(6)
    expect(result.products).toHaveLength(5)
  })

  describe('Shopify products.json fallback', () => {
    function shopifyPage(products: unknown[]): Response {
      return new Response(JSON.stringify({ products }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    it('falls back to /products.json when the page has no JSON-LD products', async () => {
      const mockFetch = vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url === 'https://shop.example.com/') {
          return new Response(html('<p>No structured data here.</p>'), { status: 200 })
        }
        if (url.startsWith('https://shop.example.com/products.json')) {
          return shopifyPage([
            {
              handle: 'sku-a',
              title: 'Product A',
              vendor: 'Shop',
              variants: [{ sku: 'v-a', price: '549.00', available: true }],
            },
          ])
        }
        return new Response('not found', { status: 404 })
      })
      globalThis.fetch = mockFetch as unknown as typeof fetch

      const result = await scanStore('https://shop.example.com/', { resolver: publicResolver })

      expect(result.products).toHaveLength(1)
      expect(result.products[0]).toMatchObject({ sku: 'sku-a', price_paise: 54900 })
      expect(result.warnings.some((w) => w.includes('used Shopify products.json fallback'))).toBe(
        true,
      )
    })

    it('tries /collections/all/products.json when the bare path yields nothing', async () => {
      const mockFetch = vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url === 'https://shop.example.com/') {
          return new Response(html('<p>No structured data here.</p>'), { status: 200 })
        }
        if (url.startsWith('https://shop.example.com/products.json')) {
          return new Response('not found', { status: 404 })
        }
        if (url.startsWith('https://shop.example.com/collections/all/products.json')) {
          return shopifyPage([
            {
              handle: 'sku-b',
              title: 'Product B',
              vendor: 'Shop',
              variants: [{ sku: 'v-b', price: '100.00', available: true }],
            },
          ])
        }
        return new Response('not found', { status: 404 })
      })
      globalThis.fetch = mockFetch as unknown as typeof fetch

      const result = await scanStore('https://shop.example.com/', { resolver: publicResolver })

      expect(result.products.map((p) => p.sku)).toEqual(['sku-b'])
    })

    it('does not hit products.json when JSON-LD products were already found', async () => {
      const mockFetch = vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url === 'https://shop.example.com/') {
          return new Response(
            html(
              jsonLd({
                '@type': 'Product',
                name: 'Product A',
                sku: 'sku-a',
                offers: { price: '10.00', priceCurrency: 'INR', availability: 'InStock' },
              }),
            ),
            { status: 200 },
          )
        }
        return new Response('not found', { status: 404 })
      })
      globalThis.fetch = mockFetch as unknown as typeof fetch

      const result = await scanStore('https://shop.example.com/', { resolver: publicResolver })

      expect(result.products.map((p) => p.sku)).toEqual(['sku-a'])
      const productsJsonCalls = mockFetch.mock.calls.filter((call) =>
        call[0]?.toString().includes('products.json'),
      )
      expect(productsJsonCalls).toHaveLength(0)
      expect(result.warnings.some((w) => w.includes('products.json fallback'))).toBe(false)
    })

    it('yields nothing when products.json is a non-Shopify JSON body, without crashing', async () => {
      const mockFetch = vi.fn(async (input: string | URL) => {
        const url = input.toString()
        if (url === 'https://shop.example.com/') {
          return new Response(html('<p>No structured data here.</p>'), { status: 200 })
        }
        // Some other JSON endpoint that happens to live at these paths but
        // isn't Shopify's products feed.
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      globalThis.fetch = mockFetch as unknown as typeof fetch

      const result = await scanStore('https://shop.example.com/', { resolver: publicResolver })

      expect(result.products).toHaveLength(0)
      expect(result.warnings.some((w) => w.includes('products.json fallback'))).toBe(false)
    })
  })
})
