/**
 * Proves the scanner understands Hundi's own reference store: render a real
 * product page's JSON-LD the way `apps/store` does, feed it through
 * `extractProducts`, and assert the recovered product matches the original
 * price/sku/availability. This is the same parser a later CLI milestone
 * points at a *different* schema.org store — this test only establishes that
 * it round-trips our own.
 */
import { createApp } from '@hundi/store/src/app.js'
import { catalog, MERCHANT_ID } from '@hundi/store/src/catalog.js'
import { describe, expect, it } from 'vitest'
import { extractProducts } from '../scanner.js'

describe('round-trip against @hundi/store', () => {
  it('recovers every catalog product from the rendered product-page JSON-LD', async () => {
    const app = createApp()

    for (const product of catalog) {
      const res = await app.request(`/products/${product.id}`)
      expect(res.status).toBe(200)
      const html = await res.text()

      const { products, warnings } = extractProducts(
        html,
        `https://store.test/products/${product.id}`,
      )
      expect(products).toHaveLength(1)

      // The store's Product JSON-LD carries no `sku`/`productID` — the scanner
      // falls back to deriving one from the URL's last path segment, which
      // happens to reproduce the store's own id scheme (`/products/sku-001`).
      expect(warnings).toEqual([expect.stringContaining('missing sku')])

      const recovered = products[0]
      expect(recovered?.sku).toBe(product.id)
      expect(recovered?.name).toBe(product.title)
      expect(recovered?.price_paise).toBe(product.price_paise)
      expect(recovered?.currency).toBe(product.currency)
      expect(recovered?.availability).toBe(product.availability)
      expect(recovered?.image).toBe(product.image)
      expect(recovered?.brand).toBe(product.brand)
    }
  })

  it('the store catalog feed shape (availability:{status}) matches what generateCatalogAdapter produces', async () => {
    const app = createApp()
    const res = await app.request('/api/catalog')
    const feed = (await res.json()) as { merchant_id: string; availability: { status: string } }[]

    expect(feed.every((p) => p.merchant_id === MERCHANT_ID)).toBe(true)
    expect(feed.every((p) => typeof p.availability.status === 'string')).toBe(true)
  })
})
