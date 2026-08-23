import { describe, expect, it } from 'vitest'
import { generateCatalogAdapter, generateLlmsTxt, generateManifest } from '../generators.js'
import type { ScanResult } from '../scanner.js'

const store: ScanResult = {
  merchant_id: 'shop-example-com',
  warnings: [],
  products: [
    {
      sku: 'sku-001',
      name: 'Velocity Runner',
      description: 'A lightweight trainer.',
      price_paise: 320000,
      currency: 'INR',
      availability: 'in_stock',
      image: 'https://shop.example.com/img/velocity.jpg',
      brand: 'Velocity Run',
      url: 'https://shop.example.com/products/velocity-runner',
    },
    {
      sku: 'sku-002',
      name: 'Cloudstep',
      description: 'Recovery shoe.',
      price_paise: 380000,
      currency: 'INR',
      availability: 'out_of_stock',
      image: 'https://shop.example.com/img/cloudstep.jpg',
      brand: 'Velocity Run',
      url: 'https://shop.example.com/products/cloudstep',
    },
  ],
}

describe('generateLlmsTxt', () => {
  it('emits an H1, a blockquote summary, and Products/Buying sections', () => {
    const text = generateLlmsTxt(store)
    const lines = text.split('\n')
    expect(lines[0]).toBe(`# ${store.merchant_id}`)
    expect(lines.some((l) => l.startsWith('> '))).toBe(true)
    expect(text).toContain('## Products')
    expect(text).toContain('## Buying')
    expect(text).toContain(store.products[0]?.name ?? '')
  })
})

describe('generateManifest', () => {
  it('includes merchant_id, catalog_endpoint, and currency from the scanned products', () => {
    const manifest = generateManifest(store)
    expect(manifest.merchant_id).toBe('shop-example-com')
    expect(manifest.catalog_endpoint).toBe('./catalog-adapter.json')
    expect(manifest.currency).toBe('INR')
    expect(manifest.version).toBeTruthy()
  })

  it('falls back to INR when the store has no products', () => {
    const manifest = generateManifest({ ...store, products: [] })
    expect(manifest.currency).toBe('INR')
  })
})

describe('generateCatalogAdapter', () => {
  it('shapes availability as {status} and keeps prices as integer paise', () => {
    const adapter = generateCatalogAdapter(store)
    expect(adapter.merchant_id).toBe('shop-example-com')
    expect(adapter.products).toHaveLength(2)
    for (const row of adapter.products) {
      expect(Number.isInteger(row.price_paise)).toBe(true)
      expect(row.availability).toEqual(
        expect.objectContaining({ status: expect.stringMatching(/^(in_stock|out_of_stock)$/) }),
      )
    }
    expect(adapter.products[1]?.availability).toEqual({ status: 'out_of_stock' })
  })
})
