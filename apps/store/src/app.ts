import { Hono } from 'hono'
import { type Availability, catalog, MERCHANT_ID, type Product } from './catalog.js'
import { POISON_PRODUCT } from './poison-fixture.js'

/** ACP-shaped availability: an object with `status`, not a bare boolean. */
type FeedAvailability = { status: Availability }

type FeedProduct = Omit<Product, 'availability'> & {
  availability: FeedAvailability
  merchant_id: string
}

/** schema.org and agent feeds want absolute image URLs; the catalog stores them
 * as self-served relative paths (`/img/sku-001`) so the store has no external
 * image dependency. Resolve to absolute against the request origin at emit time. */
function absoluteImage(image: string, origin: string): string {
  return image.startsWith('http') ? image : `${origin}${image}`
}

function toFeedProduct(product: Product, origin: string): FeedProduct {
  const { availability, ...rest } = product
  return {
    ...rest,
    image: absoluteImage(product.image, origin),
    availability: { status: availability },
    merchant_id: MERCHANT_ID,
  }
}

/** schema.org Offer.price wants a decimal-rupee string ("3200.00"), not the
 * integer paise the catalog stores internally. */
function toRupeeString(pricePaise: number): string {
  return (pricePaise / 100).toFixed(2)
}

function toSchemaAvailability(availability: Availability): string {
  return availability === 'in_stock'
    ? 'https://schema.org/InStock'
    : 'https://schema.org/OutOfStock'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Guards against a payload that happens to contain a literal `</script>` —
 * JSON.stringify does not escape `<`, so an unguarded interpolation could
 * terminate the surrounding script element early. */
function toJsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  a { color: #1a56db; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.5rem; list-style: none; padding: 0; }
  .product-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 1rem; }
  .product-card img { width: 100%; border-radius: 4px; }
  .price { font-weight: 600; }
  .oos { color: #b91c1c; font-size: 0.85rem; }
</style>
</head>
<body>
${body}
</body>
</html>`
}

function productCard(product: Product): string {
  const priceLabel = `₹${toRupeeString(product.price_paise)}`
  const oosLabel = product.availability === 'out_of_stock' ? '<p class="oos">Out of stock</p>' : ''
  return `<li class="product-card">
  <a href="/products/${escapeHtml(product.id)}">
    <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}">
    <h2>${escapeHtml(product.title)}</h2>
  </a>
  <p>${escapeHtml(product.brand)}</p>
  <p class="price">${priceLabel}</p>
  ${oosLabel}
</li>`
}

/** Deterministic brand→gradient so every product tile is stable across reloads
 * (important for a clean screen-recording) and self-served — no external image
 * host to fail on camera. */
function brandColors(brand: string): [string, string] {
  const palettes: [string, string][] = [
    ['#1e3a8a', '#3b82f6'],
    ['#065f46', '#10b981'],
    ['#7c2d12', '#f97316'],
    ['#581c87', '#a855f7'],
    ['#831843', '#ec4899'],
    ['#134e4a', '#14b8a6'],
  ]
  let h = 0
  for (const ch of brand) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palettes[h % palettes.length]!
}

function productImageSvg(product: Product): string {
  const [c1, c2] = brandColors(product.brand)
  const name = escapeHtml(product.title)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="600" height="600" fill="url(#g)"/>
  <text x="300" y="330" font-size="230" text-anchor="middle">👟</text>
  <text x="300" y="470" font-size="34" font-family="system-ui,sans-serif" font-weight="600"
        fill="#ffffff" text-anchor="middle">${name}</text>
</svg>`
}

export function createApp(): Hono {
  const app = new Hono()

  app.get('/img/:id', (c) => {
    const product = catalog.find((p) => p.id === c.req.param('id'))
    if (!product) return c.text('not found', 404)
    return c.body(productImageSvg(product), 200, { 'content-type': 'image/svg+xml' })
  })

  app.get('/', (c) => {
    const items = catalog.map(productCard).join('\n')
    const body = `<h1>Hundi Demo Store</h1>
<p>A synthetic running-shoes storefront built for agent-readability.</p>
<ul class="product-grid">
${items}
</ul>`
    return c.html(pageShell('Hundi Demo Store', body))
  })

  app.get('/products/:id', (c) => {
    const product = catalog.find((p) => p.id === c.req.param('id'))
    if (!product) {
      return c.html(pageShell('Not found', '<h1>404 Not Found</h1><p>No such product.</p>'), 404)
    }

    const jsonLd = {
      '@context': 'https://schema.org/',
      '@type': 'Product',
      name: product.title,
      image: absoluteImage(product.image, new URL(c.req.url).origin),
      description: product.description,
      brand: { '@type': 'Brand', name: product.brand },
      offers: {
        '@type': 'Offer',
        price: toRupeeString(product.price_paise),
        priceCurrency: product.currency,
        availability: toSchemaAvailability(product.availability),
      },
    }

    const body = `<p><a href="/">&larr; All products</a></p>
<h1>${escapeHtml(product.title)}</h1>
<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" style="max-width:400px">
<p>${escapeHtml(product.brand)}</p>
<p class="price">₹${toRupeeString(product.price_paise)}</p>
<p>${escapeHtml(product.description)}</p>
<p>${product.availability === 'in_stock' ? 'In stock' : '<span class="oos">Out of stock</span>'}</p>
<script type="application/ld+json">${toJsonLdScript(jsonLd)}</script>`
    return c.html(pageShell(product.title, body))
  })

  app.get('/llms.txt', (c) => {
    const base = new URL(c.req.url).origin
    const highlights = [catalog[0], catalog[4], catalog[16]]
      .filter((p): p is Product => p !== undefined)
      .map((p) => `- [${p.title}](${base}/products/${p.id})`)
      .join('\n')

    const body = `# Hundi Demo Store

> A synthetic running-shoes storefront built to be read by AI shopping agents: every product exposes machine-readable price, availability, and identity so an agent can browse and buy without scraping HTML.

## Products

- Full catalog (JSON): ${base}/api/catalog
${highlights}

## Buying

Agents should fetch the capability manifest at ${base}/.well-known/hundi.json to discover the catalog endpoint, currency, and how to submit a cart to the Hundi facilitator for settlement.
`
    return c.text(body)
  })

  app.get('/.well-known/hundi.json', (c) => {
    return c.json({
      version: '0.1',
      merchant_id: MERCHANT_ID,
      catalog_endpoint: '/api/catalog',
      product_endpoint: '/api/products/{id}',
      currency: 'INR',
      facilitator_hint: 'submit carts to the Hundi facilitator',
    })
  })

  app.get('/api/catalog', (c) => {
    const origin = new URL(c.req.url).origin
    const poisoned = c.req.query('poisoned') === '1'
    const products = poisoned ? [...catalog, POISON_PRODUCT] : catalog
    return c.json(products.map((p) => toFeedProduct(p, origin)))
  })

  app.get('/api/products/:id', (c) => {
    const product = catalog.find((p) => p.id === c.req.param('id'))
    if (!product) {
      return c.json({ ok: false, error: 'NOT_FOUND' }, 404)
    }
    return c.json(toFeedProduct(product, new URL(c.req.url).origin))
  })

  return app
}
