/**
 * Static-site generator: renders the whole catalog into a directory as
 * plain HTML files with embedded JSON-LD, with no server-side templating at
 * request time. Unlike apps/store (a Hono server that renders on request),
 * this store is pre-rendered once and then served as-is by serve.ts — the
 * "store becomes a static HTML page" shape. `build()` is parameterized on
 * output directory so tests can render into a temp dir instead of the real
 * dist/.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalog, MERCHANT_ID, type Product } from './catalog.js'
import { renderIndexJsonLd, renderProductJsonLd } from './jsonld.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST_DIR = join(__dirname, '..', 'dist')

export const BASE_URL = 'https://kitchenware.hundi.test/'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** JSON.stringify never escapes `<`, so an unguarded interpolation of a
 * value containing a literal `</script>` could terminate the surrounding
 * element early. */
function toScriptSafe(json: string): string {
  return json.replace(/</g, '\\u003c')
}

function priceLabel(pricePaise: number): string {
  return `Rs ${(pricePaise / 100).toFixed(2)}`
}

function pageShell(title: string, body: string, jsonLd: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script type="application/ld+json">${toScriptSafe(jsonLd)}</script>
</head>
<body>
${body}
</body>
</html>`
}

function productLink(product: Product): string {
  return `<li><a href="product-${product.sku}.html">${escapeHtml(product.title)} — ${priceLabel(product.price_paise)}</a></li>`
}

function buildIndexHtml(): string {
  const items = catalog.map(productLink).join('\n')
  const body = `<h1>Hundi Kitchenware Co.</h1>
<p>A synthetic coffee &amp; kitchenware storefront, statically rendered for agent-readability.</p>
<ul>
${items}
</ul>`
  return pageShell('Hundi Kitchenware Co.', body, renderIndexJsonLd(catalog, BASE_URL))
}

function buildProductHtml(product: Product): string {
  const stockLabel = product.availability === 'in_stock' ? 'In stock' : 'Out of stock'
  const body = `<p><a href="index.html">&larr; All products</a></p>
<h1>${escapeHtml(product.title)}</h1>
<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}">
<p>${escapeHtml(product.brand)}</p>
<p>${priceLabel(product.price_paise)}</p>
<p>${escapeHtml(product.description)}</p>
<p>${stockLabel}</p>`
  return pageShell(product.title, body, renderProductJsonLd(product, BASE_URL))
}

export async function build(outDir: string = DEFAULT_DIST_DIR): Promise<{ productCount: number }> {
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), buildIndexHtml(), 'utf8')
  for (const product of catalog) {
    await writeFile(join(outDir, `product-${product.sku}.html`), buildProductHtml(product), 'utf8')
  }
  return { productCount: catalog.length }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build()
    .then(({ productCount }) => {
      console.log(`built ${productCount} product pages for ${MERCHANT_ID} -> ${DEFAULT_DIST_DIR}`)
    })
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
}
