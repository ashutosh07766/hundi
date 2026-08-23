import { describe, expect, it } from 'vitest'
import { extractShopifyProducts } from '../scanner.js'

const BASE_URL = 'https://myfrido.com/products.json'

function shopifyFeed(products: unknown[]): unknown {
  return { products }
}

describe('extractShopifyProducts', () => {
  it('maps a Shopify products.json feed onto the scanner product shape', () => {
    const json = shopifyFeed([
      {
        handle: 'compression-socks',
        title: 'Compression Socks',
        body_html: '<p>Boosts <strong>circulation</strong> during long flights.</p>',
        vendor: 'Frido',
        images: [{ src: 'https://cdn.shopify.com/s/files/1/socks.jpg' }],
        variants: [{ sku: 'SKU-SOCKS-1', price: '549.00', available: true }],
      },
      {
        handle: 'foot-cushion',
        title: 'Foot Cushion',
        body_html: '',
        vendor: 'Frido',
        images: [],
        variants: [{ sku: '', price: '4499.00', available: false }],
      },
    ])

    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')

    expect(products).toHaveLength(2)
    expect(warnings).toHaveLength(0)

    const socks = products.find((p) => p.sku === 'compression-socks')
    expect(socks).toMatchObject({
      sku: 'compression-socks',
      name: 'Compression Socks',
      price_paise: 54900,
      currency: 'INR',
      availability: 'in_stock',
      brand: 'Frido',
      image: 'https://cdn.shopify.com/s/files/1/socks.jpg',
      description: 'Boosts circulation during long flights.',
    })

    const cushion = products.find((p) => p.sku === 'foot-cushion')
    expect(cushion).toMatchObject({
      sku: 'foot-cushion',
      price_paise: 449900,
      availability: 'out_of_stock',
      image: '',
      description: '',
    })
  })

  it('prefers the product handle over variant sku', () => {
    const json = shopifyFeed([
      {
        handle: 'the-handle',
        title: 'Handle Preferred',
        vendor: 'Frido',
        variants: [{ sku: 'SKU-OTHER', price: '100.00', available: true }],
      },
    ])

    const { products } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products[0]?.sku).toBe('the-handle')
  })

  it('falls back to variant sku when handle is missing', () => {
    const json = shopifyFeed([
      {
        title: 'No Handle',
        vendor: 'Frido',
        variants: [{ sku: 'SKU-FALLBACK', price: '100.00', available: true }],
      },
    ])

    const { products } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products[0]?.sku).toBe('SKU-FALLBACK')
  })

  it('falls back to the merchant id as brand when vendor is absent', () => {
    const json = shopifyFeed([
      {
        handle: 'no-vendor',
        title: 'No Vendor',
        variants: [{ sku: 'SKU-X', price: '100.00', available: true }],
      },
    ])

    const { products } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products[0]?.brand).toBe('myfrido-com')
  })

  it('skips a product with no variants and records a warning', () => {
    const json = shopifyFeed([{ handle: 'empty', title: 'Empty Variants', variants: [] }])
    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products).toHaveLength(0)
    expect(warnings.some((w) => w.includes('no variants'))).toBe(true)
  })

  it('skips a product with a non-numeric price and records a warning', () => {
    const json = shopifyFeed([
      {
        handle: 'bad-price',
        title: 'Bad Price',
        variants: [{ sku: 'SKU-BAD', price: 'not-a-number', available: true }],
      },
    ])
    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products).toHaveLength(0)
    expect(warnings.some((w) => w.includes('no usable price'))).toBe(true)
  })

  it('skips a product with a zero price and records a warning', () => {
    const json = shopifyFeed([
      {
        handle: 'zero-price',
        title: 'Zero Price',
        variants: [{ sku: 'SKU-ZERO', price: '0.00', available: true }],
      },
    ])
    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products).toHaveLength(0)
    expect(warnings.some((w) => w.includes('no usable price'))).toBe(true)
  })

  it('skips a product missing a title and records a warning', () => {
    const json = shopifyFeed([
      { handle: 'no-title', variants: [{ sku: 'SKU-NT', price: '100.00', available: true }] },
    ])
    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products).toHaveLength(0)
    expect(warnings.some((w) => w.includes('missing title'))).toBe(true)
  })

  it('truncates a long description to ~300 chars', () => {
    const long = `<p>${'a'.repeat(400)}</p>`
    const json = shopifyFeed([
      {
        handle: 'long-desc',
        title: 'Long Description',
        body_html: long,
        variants: [{ sku: 'SKU-LONG', price: '100.00', available: true }],
      },
    ])
    const { products } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products[0]?.description.length).toBeLessThanOrEqual(301)
  })

  it('returns no products and no warnings for a non-Shopify JSON shape', () => {
    const { products, warnings } = extractShopifyProducts({ hello: 'world' }, BASE_URL, 'x')
    expect(products).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })
})
