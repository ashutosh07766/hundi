import { describe, expect, it } from 'vitest'
import { extractLinks, extractProducts } from '../scanner.js'

const BASE_URL = 'https://shop.example.com/products/velocity-runner'

function jsonLd(payload: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(payload)}</script>`
}

describe('extractProducts', () => {
  it('parses a valid single-object Product with a nested Offer', () => {
    const html = `<html><body>${jsonLd({
      '@context': 'https://schema.org/',
      '@type': 'Product',
      name: 'Velocity Runner',
      sku: 'sku-001',
      description: 'A lightweight trainer.',
      image: 'https://shop.example.com/img/velocity.jpg',
      brand: { '@type': 'Brand', name: 'Velocity Run' },
      offers: {
        '@type': 'Offer',
        price: '3200.00',
        priceCurrency: 'INR',
        availability: 'https://schema.org/InStock',
      },
    })}</body></html>`

    const { products, warnings } = extractProducts(html, BASE_URL)

    expect(products).toHaveLength(1)
    expect(products[0]).toMatchObject({
      sku: 'sku-001',
      name: 'Velocity Runner',
      price_paise: 320000,
      currency: 'INR',
      availability: 'in_stock',
      brand: 'Velocity Run',
      image: 'https://shop.example.com/img/velocity.jpg',
    })
    expect(warnings).toHaveLength(0)
  })

  it('handles an @graph array containing a Product among other node types', () => {
    const html = `<html><body>${jsonLd({
      '@context': 'https://schema.org/',
      '@graph': [
        { '@type': 'WebPage', name: 'Product page' },
        {
          '@type': 'Product',
          name: 'Graph Runner',
          sku: 'sku-graph',
          offers: { price: 1999.5, priceCurrency: 'INR', availability: 'InStock' },
        },
      ],
    })}</body></html>`

    const { products } = extractProducts(html, BASE_URL)
    expect(products).toHaveLength(1)
    expect(products[0]?.sku).toBe('sku-graph')
    expect(products[0]?.price_paise).toBe(199950)
  })

  it('handles a bare array of Product nodes', () => {
    const html = `<html><body>${jsonLd([
      {
        '@type': 'Product',
        name: 'Array Runner One',
        sku: 'sku-a1',
        offers: { price: '10.00', priceCurrency: 'INR', availability: 'InStock' },
      },
      {
        '@type': 'Product',
        name: 'Array Runner Two',
        sku: 'sku-a2',
        offers: { price: '20.00', priceCurrency: 'INR', availability: 'InStock' },
      },
    ])}</body></html>`

    const { products } = extractProducts(html, BASE_URL)
    expect(products.map((p) => p.sku).sort()).toEqual(['sku-a1', 'sku-a2'])
  })

  it('skips a product missing a price and records a warning', () => {
    const html = `<html><body>${jsonLd({
      '@type': 'Product',
      name: 'No Price Runner',
      sku: 'sku-nopay',
    })}</body></html>`

    const { products, warnings } = extractProducts(html, BASE_URL)
    expect(products).toHaveLength(0)
    expect(warnings.some((w) => w.includes('missing price') && w.includes('No Price Runner'))).toBe(
      true,
    )
  })

  it('maps OutOfStock availability URLs to out_of_stock', () => {
    const html = `<html><body>${jsonLd({
      '@type': 'Product',
      name: 'OOS Runner',
      sku: 'sku-oos',
      offers: {
        price: '50.00',
        priceCurrency: 'INR',
        availability: 'https://schema.org/OutOfStock',
      },
    })}</body></html>`

    const { products } = extractProducts(html, BASE_URL)
    expect(products[0]?.availability).toBe('out_of_stock')
  })

  it('returns a "no JSON-LD found" warning and no products when the page has none', () => {
    const html = '<html><body><h1>Just a plain page</h1></body></html>'
    const { products, warnings } = extractProducts(html, BASE_URL)
    expect(products).toHaveLength(0)
    expect(warnings).toEqual([`no JSON-LD found on ${BASE_URL}`])
  })

  it('derives a sku from the URL when one is missing', () => {
    const html = `<html><body>${jsonLd({
      '@type': 'Product',
      name: 'No Sku Runner',
      offers: { price: '30.00', priceCurrency: 'INR', availability: 'InStock' },
    })}</body></html>`

    const { products, warnings } = extractProducts(html, BASE_URL)
    expect(products[0]?.sku).toBe('velocity-runner')
    expect(warnings.some((w) => w.includes('derived "velocity-runner"'))).toBe(true)
  })

  it('normalizes a relative image URL against the base and warns', () => {
    const html = `<html><body>${jsonLd({
      '@type': 'Product',
      name: 'Relative Image Runner',
      sku: 'sku-rel',
      image: '/img/relative.jpg',
      offers: { price: '30.00', priceCurrency: 'INR', availability: 'InStock' },
    })}</body></html>`

    const { products, warnings } = extractProducts(html, BASE_URL)
    expect(products[0]?.image).toBe('https://shop.example.com/img/relative.jpg')
    expect(warnings.some((w) => w.includes('normalized relative image URL'))).toBe(true)
  })

  it('recovers from a malformed JSON-LD block without throwing', () => {
    const html = `<html><body><script type="application/ld+json">{not valid json</script></body></html>`
    const { products, warnings } = extractProducts(html, BASE_URL)
    expect(products).toHaveLength(0)
    expect(warnings.some((w) => w.includes('malformed JSON-LD'))).toBe(true)
  })
})

describe('extractLinks', () => {
  it('collects same-origin links, dedupes, and drops hashes/foreign origins', () => {
    const html = `
      <a href="/products/a">A</a>
      <a href="/products/b#section">B</a>
      <a href="/products/a">A again</a>
      <a href="https://other.example.com/products/c">C</a>
      <a href="mailto:hi@example.com">mail</a>
    `
    const links = extractLinks(html, BASE_URL)
    expect(links).toEqual([
      'https://shop.example.com/products/a',
      'https://shop.example.com/products/b',
    ])
  })

  it('drops cart/checkout/account routes and their sub-paths', () => {
    const html = `
      <a href="/products/a">A</a>
      <a href="/cart">Cart</a>
      <a href="/cart/change?line=1">Change</a>
      <a href="/checkout">Checkout</a>
      <a href="/account">Account</a>
      <a href="/account/login">Login</a>
    `
    const links = extractLinks(html, BASE_URL)
    expect(links).toEqual(['https://shop.example.com/products/a'])
  })

  it('does not drop a product path that merely contains "cart" as a substring', () => {
    const html = `<a href="/products/golf-cart-cover">Golf Cart Cover</a>`
    const links = extractLinks(html, BASE_URL)
    expect(links).toEqual(['https://shop.example.com/products/golf-cart-cover'])
  })
})
