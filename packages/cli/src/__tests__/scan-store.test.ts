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
})
