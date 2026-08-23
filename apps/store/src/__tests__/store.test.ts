import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { catalog } from '../catalog.js'

function extractJsonLd(html: string): unknown {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
  if (!match || match[1] === undefined) throw new Error('no JSON-LD script tag found')
  return JSON.parse(match[1])
}

describe('GET /api/catalog', () => {
  it('returns all catalog products', async () => {
    const app = createApp()
    const res = await app.request('/api/catalog')
    expect(res.status).toBe(200)
    const json = (await res.json()) as unknown[]
    expect(json).toHaveLength(catalog.length)
    expect(json).toHaveLength(20)
  })

  it('adds the poison fixture only when ?poisoned=1 is set', async () => {
    const app = createApp()
    const clean = await (await app.request('/api/catalog')).json()
    const poisoned = await (await app.request('/api/catalog?poisoned=1')).json()
    expect(clean).toHaveLength(20)
    expect(poisoned).toHaveLength(21)
    expect((poisoned as { id: string }[]).some((p) => p.id === 'sku-poison')).toBe(true)
    expect((clean as { id: string }[]).some((p) => p.id === 'sku-poison')).toBe(false)
  })

  it('shapes availability as an object with a status field, not a boolean', async () => {
    const app = createApp()
    const res = await app.request('/api/catalog')
    const json = (await res.json()) as { availability: unknown; merchant_id: string }[]
    for (const product of json) {
      expect(product.availability).toEqual(
        expect.objectContaining({ status: expect.stringMatching(/^(in_stock|out_of_stock)$/) }),
      )
      expect(product.merchant_id).toBe('demo-store-1')
    }
  })
})

describe('GET /api/products/:id', () => {
  it('returns a single product in the feed shape', async () => {
    const app = createApp()
    const res = await app.request('/api/products/sku-001')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { id: string; availability: { status: string } }
    expect(json.id).toBe('sku-001')
    expect(json.availability.status).toBe('in_stock')
  })

  it('404s as JSON for an unknown id', async () => {
    const app = createApp()
    const res = await app.request('/api/products/does-not-exist')
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false })
  })
})

describe('GET /products/:id', () => {
  it('embeds parseable JSON-LD with the correct decimal price and availability URL', async () => {
    const app = createApp()
    const res = await app.request('/products/sku-001')
    expect(res.status).toBe(200)
    const html = await res.text()

    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
    expect(match).not.toBeNull()
    const jsonLd = JSON.parse(match![1]!)

    expect(jsonLd['@type']).toBe('Product')
    expect(jsonLd.offers.price).toBe('3200.00')
    expect(jsonLd.offers.priceCurrency).toBe('INR')
    expect(jsonLd.offers.availability).toBe('https://schema.org/InStock')
  })

  it('marks an out-of-stock product with the OutOfStock availability URL', async () => {
    const app = createApp()
    const res = await app.request('/products/sku-003')
    const html = await res.text()
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
    const jsonLd = JSON.parse(match![1]!)
    expect(jsonLd.offers.availability).toBe('https://schema.org/OutOfStock')
  })

  it('404s for an unknown id', async () => {
    const app = createApp()
    const res = await app.request('/products/does-not-exist')
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).toContain('404')
  })
})

describe('GET /', () => {
  it('lists product links', async () => {
    const app = createApp()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('/products/sku-001')
    expect(html).toContain('/products/sku-020')
  })
})

describe('GET /llms.txt', () => {
  it('is llmstxt.org shaped: H1 title, blockquote summary, and section headers', async () => {
    const app = createApp()
    const res = await app.request('/llms.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toMatch(/^# .+/m)
    expect(text).toMatch(/^> .+/m)
    expect(text).toContain('## Products')
    expect(text).toContain('## Buying')
    expect(text).toContain('/.well-known/hundi.json')
  })
})

describe('GET /.well-known/hundi.json', () => {
  it('returns the capability manifest', async () => {
    const app = createApp()
    const res = await app.request('/.well-known/hundi.json')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      version: '0.1',
      merchant_id: 'demo-store-1',
      catalog_endpoint: '/api/catalog',
      currency: 'INR',
    })
  })
})
