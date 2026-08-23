import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractProducts } from '@hundi/cli'
import { afterEach, describe, expect, it } from 'vitest'
import { BASE_URL, build } from '../build.js'
import { catalog } from '../catalog.js'
import { renderIndexJsonLd, renderProductJsonLd } from '../jsonld.js'

describe('renderIndexJsonLd', () => {
  it('produces a parseable @graph containing every catalog product plus a non-Product node', () => {
    const parsed = JSON.parse(renderIndexJsonLd(catalog, BASE_URL)) as {
      '@graph': Array<Record<string, unknown>>
    }
    const productNodes = parsed['@graph'].filter((n) => n['@type'] === 'Product')
    expect(productNodes).toHaveLength(catalog.length)
    expect(parsed['@graph'].some((n) => n['@type'] === 'WebSite')).toBe(true)
  })

  it('encodes price as a decimal-rupee string, not integer paise', () => {
    const parsed = JSON.parse(renderIndexJsonLd(catalog, BASE_URL)) as {
      '@graph': Array<{ sku?: string; offers?: Array<{ price: string }> }>
    }
    const kettle = parsed['@graph'].find((n) => n.sku === 'KW-003')
    expect(kettle?.offers?.[0]?.price).toBe('2199.00')
  })
})

describe('renderProductJsonLd', () => {
  it('emits offers as an array — the schema.org shape apps/store does not use', () => {
    const product = catalog[0]
    if (!product) throw new Error('catalog is empty')
    const parsed = JSON.parse(renderProductJsonLd(product, BASE_URL)) as { offers: unknown }
    expect(Array.isArray(parsed.offers)).toBe(true)
  })
})

describe('CLI genericity — same scanner, second store, no shared code', () => {
  let outDir: string | undefined

  afterEach(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('extractProducts recovers the full catalog from statically-built HTML', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'hundi-store2-'))
    const { productCount } = await build(outDir)
    expect(productCount).toBe(catalog.length)

    // store #1 (apps/store, Hono, per-page Product) and store #2 (this
    // package, static HTML, @graph index + array-form offers) share NO
    // code; the CLI scanner understands both — that is the "make any store
    // agent-transactable" claim, proven.
    const indexHtml = await readFile(join(outDir, 'index.html'), 'utf8')
    const { products: fromIndex, warnings: indexWarnings } = extractProducts(indexHtml, BASE_URL)
    expect(indexWarnings).toHaveLength(0)
    expect(fromIndex.map((p) => p.sku).sort()).toEqual(catalog.map((p) => p.sku).sort())

    const bySku = new Map(fromIndex.map((p) => [p.sku, p]))
    for (const product of catalog) {
      const recovered = bySku.get(product.sku)
      expect(recovered).toBeDefined()
      expect(recovered?.name).toBe(product.title)
      expect(recovered?.price_paise).toBe(product.price_paise)
      expect(recovered?.currency).toBe(product.currency)
      expect(recovered?.availability).toBe(product.availability)
      expect(recovered?.brand).toBe(product.brand)
      expect(recovered?.image).toBe(product.image)
    }

    // Independently: the per-product pages (single-object JSON-LD,
    // array-form offers) round-trip too, not just the @graph index.
    for (const product of catalog) {
      const html = await readFile(join(outDir, `product-${product.sku}.html`), 'utf8')
      const productUrl = `${BASE_URL}product-${product.sku}.html`
      const { products, warnings } = extractProducts(html, productUrl)
      expect(warnings).toHaveLength(0)
      expect(products).toHaveLength(1)

      const recovered = products[0]
      expect(recovered?.sku).toBe(product.sku)
      expect(recovered?.price_paise).toBe(product.price_paise)
      expect(recovered?.availability).toBe(product.availability)
    }
  })
})
