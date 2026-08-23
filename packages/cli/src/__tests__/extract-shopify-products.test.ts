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

describe('extractShopifyProducts — duplicate handling', () => {
  function sockVariant(id: number, color: string, available: boolean) {
    return { id, title: color, option1: color, price: '499.00', available }
  }

  it('excludes a reserved-route-suffixed handle that duplicates a real product, keeps a genuinely distinct sibling', () => {
    const json = shopifyFeed([
      {
        handle: 'frido-active-socks',
        title: 'Frido Active Socks',
        vendor: 'Frido',
        options: [{ name: 'Color', values: ['Black', 'Red'] }],
        variants: [sockVariant(1, 'Black', true), sockVariant(2, 'Red', true)],
      },
      {
        // A real, distinct product — same title, but "ankle length" is a
        // meaningful qualifier, not a reserved storefront route word, so it
        // must never be treated as a duplicate of the base product.
        handle: 'frido-active-socks-ankle-length',
        title: 'Frido Active Socks',
        vendor: 'Frido',
        options: [{ name: 'Color', values: ['Black', 'Red'] }],
        variants: [sockVariant(3, 'Black', false), sockVariant(4, 'Red', true)],
      },
      {
        // Shadow/duplicate listing — same title as the base product, handle
        // carries the reserved "-cart" route suffix, and shows a color as
        // out of stock while the base listing shows it in stock.
        handle: 'frido-active-socks-cart',
        title: 'Frido Active Socks',
        vendor: 'Frido',
        options: [{ name: 'Color', values: ['Black', 'Red'] }],
        variants: [sockVariant(5, 'Black', true), sockVariant(6, 'Red', false)],
      },
    ])

    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')

    expect(products.map((p) => p.sku).sort()).toEqual([
      'frido-active-socks',
      'frido-active-socks-ankle-length',
    ])
    const base = products.find((p) => p.sku === 'frido-active-socks')
    // The base listing's own stock data is untouched by the excluded duplicate.
    expect(base?.variants?.every((v) => v.available)).toBe(true)
    expect(
      warnings.some(
        (w) => w.includes('excluded "frido-active-socks-cart"') && w.includes('frido-active-socks'),
      ),
    ).toBe(true)
  })

  it('does not exclude a "-cart" handle when no sibling with a matching name exists', () => {
    const json = shopifyFeed([
      {
        handle: 'golf-cart',
        title: 'Golf Cart Cover',
        vendor: 'Acme',
        variants: [{ sku: 'SKU-GC', price: '999.00', available: true }],
      },
    ])
    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products.map((p) => p.sku)).toEqual(['golf-cart'])
    expect(warnings).toHaveLength(0)
  })

  it('merges two catalog entries that share the same handle, unioning variants and favoring availability', () => {
    const json = shopifyFeed([
      {
        handle: 'dup-product',
        title: 'Dup Product',
        vendor: 'Frido',
        options: [{ name: 'Color', values: ['Black', 'Red'] }],
        variants: [sockVariant(10, 'Black', true), sockVariant(11, 'Red', false)],
      },
      {
        // Same handle, e.g. listed under a second collection page — stock
        // states disagree with the first occurrence for both variants.
        handle: 'dup-product',
        title: 'Dup Product',
        vendor: 'Frido',
        options: [{ name: 'Color', values: ['Black', 'Red'] }],
        variants: [sockVariant(10, 'Black', false), sockVariant(11, 'Red', true)],
      },
    ])

    const { products, warnings } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')

    expect(products).toHaveLength(1)
    const merged = products[0]!
    expect(merged.sku).toBe('dup-product')
    expect(merged.variants).toHaveLength(2)
    // A variant reported available by either occurrence wins.
    expect(merged.variants?.every((v) => v.available)).toBe(true)
    expect(warnings.some((w) => w.includes('merged duplicate') && w.includes('dup-product'))).toBe(
      true,
    )
  })
})

describe('extractShopifyProducts — variants', () => {
  it('captures every variant with its option_values for a multi-variant product', () => {
    const json = shopifyFeed([
      {
        handle: 'active-walking-shoes',
        title: 'Active Walking Shoes',
        vendor: 'Frido',
        images: [{ src: 'https://cdn.shopify.com/s/files/1/shoes.jpg' }],
        options: [{ name: 'Size', values: ['9', '10', '11'] }],
        variants: [
          { id: 1001, title: '9', option1: '9', price: '3200.00', available: true, sku: 'SKU-9' },
          {
            id: 1002,
            title: '10',
            option1: '10',
            price: '3200.00',
            available: true,
            sku: 'SKU-10',
          },
          {
            id: 1003,
            title: '11',
            option1: '11',
            price: '3400.00',
            available: false,
            sku: 'SKU-11',
          },
        ],
      },
    ])

    const { products } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products).toHaveLength(1)
    const product = products[0]!

    // Product-level price/availability still reflect the first variant (legacy
    // flat-catalog fields), unchanged by variant capture.
    expect(product.price_paise).toBe(320000)
    expect(product.availability).toBe('in_stock')

    expect(product.options).toEqual([{ name: 'Size', values: ['9', '10', '11'] }])
    expect(product.variants).toHaveLength(3)
    expect(product.variants).toEqual([
      {
        variant_id: '1001',
        label: '9',
        option_values: ['9'],
        price_paise: 320000,
        available: true,
        sku: 'SKU-9',
      },
      {
        variant_id: '1002',
        label: '10',
        option_values: ['10'],
        price_paise: 320000,
        available: true,
        sku: 'SKU-10',
      },
      {
        variant_id: '1003',
        label: '11',
        option_values: ['11'],
        price_paise: 340000,
        available: false,
        sku: 'SKU-11',
      },
    ])
  })

  it('maps option1/option2/option3 into option_values in order for multi-option variants', () => {
    const json = shopifyFeed([
      {
        handle: 'trail-runner',
        title: 'Trail Runner',
        vendor: 'Frido',
        options: [
          { name: 'Size', values: ['9', '10'] },
          { name: 'Color', values: ['Black', 'Red'] },
        ],
        variants: [
          {
            id: 1,
            title: '9 / Black',
            option1: '9',
            option2: 'Black',
            price: '3000.00',
            available: true,
          },
          {
            id: 2,
            title: '10 / Red',
            option1: '10',
            option2: 'Red',
            price: '3000.00',
            available: true,
          },
        ],
      },
    ])

    const { products } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products[0]?.variants?.[0]?.option_values).toEqual(['9', 'Black'])
    expect(products[0]?.variants?.[0]?.label).toBe('9 / Black')
    expect(products[0]?.variants?.[1]?.option_values).toEqual(['10', 'Red'])
  })

  it('leaves variants and options undefined for a single "Default Title" variant (unchanged behavior)', () => {
    const json = shopifyFeed([
      {
        handle: 'compression-socks',
        title: 'Compression Socks',
        vendor: 'Frido',
        options: [{ name: 'Title', values: ['Default Title'] }],
        variants: [
          {
            id: 5001,
            title: 'Default Title',
            option1: 'Default Title',
            price: '549.00',
            available: true,
            sku: 'SKU-SOCKS-1',
          },
        ],
      },
    ])

    const { products } = extractShopifyProducts(json, BASE_URL, 'myfrido-com')
    expect(products).toHaveLength(1)
    const product = products[0]!
    expect(product.variants).toBeUndefined()
    expect(product.options).toBeUndefined()
    // The rest of the flat-product shape is exactly what it was before variant
    // capture existed.
    expect(product).toMatchObject({
      sku: 'compression-socks',
      name: 'Compression Socks',
      price_paise: 54900,
      availability: 'in_stock',
    })
  })
})
