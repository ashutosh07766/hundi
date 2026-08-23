/**
 * Headless-browser fallback for the Shopify products.json scan, used when the
 * server-side scan (`@hundi/cli/scanner`'s plain `fetch`) comes back empty.
 * Some storefronts sit behind bot-protection (observed: myfrido.com serves a
 * Cloudflare challenge — HTTP 429 — to Node's `fetch`, but returns a normal
 * 200 with the JSON body to a real browser context) — a headless Chromium
 * page is indistinguishable from a human visitor to that kind of gate, so
 * routing the same request through one recovers stores a plain fetch can't
 * reach. This is strictly a fallback: booting Chromium and navigating a page
 * costs much more than a single `fetch` call, so it only runs after the fast
 * path yields zero usable products.
 *
 * Reuses `extractShopifyProducts` (`@hundi/cli/scanner`) for the JSON-to-
 * product mapping — the only new surface here is *how* the JSON text is
 * fetched, not how it's parsed.
 */

import { extractShopifyProducts, type ScannedProduct } from '@hundi/cli/scanner'
import type { Browser, BrowserContext } from 'playwright'
import { chromium } from 'playwright'

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SHOPIFY_PRODUCTS_JSON_PATHS = ['/products.json', '/collections/all/products.json']
const PAGE_LIMIT = 250
const MAX_PAGES = 3
const MAX_PRODUCTS = 500
const DEFAULT_TIMEOUT_MS = 25_000

// Lazily launched, then kept alive for the process lifetime — booting Chromium is the
// expensive part of this fallback, so every call after the first reuses the same
// browser instance and only pays for a fresh context + page.
let browserPromise: Promise<Browser> | undefined

function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true })
  return browserPromise
}

/** Closes the shared headless-browser instance, if one was ever launched. Call this on
 * process shutdown so a scan-triggered Chromium process doesn't outlive the server. */
export async function closeBrowserScanner(): Promise<void> {
  if (!browserPromise) return
  const pending = browserPromise
  browserPromise = undefined
  const browser = await pending
  await browser.close().catch(() => {})
}

/** Fetches `url` in a real (headless) browser context and returns the rendered page
 * body's text — for a `/products.json` URL, that's the raw JSON payload a Node
 * `fetch()` can be denied on bot-gated stores. Best-effort: any navigation failure or
 * timeout returns null rather than throwing, since this always runs as a fallback path
 * that must not itself become a new failure mode. Each call opens and closes its own
 * context so cookies/state never leak between unrelated store scans; the browser
 * process itself is reused across calls. */
export async function browserFetchText(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  let context: BrowserContext | undefined
  try {
    const browser = await getBrowser()
    context = await browser.newContext({ userAgent: DESKTOP_CHROME_UA })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    return await page.evaluate(() => document.body.innerText)
  } catch {
    return null
  } finally {
    await context?.close().catch(() => {})
  }
}

function extractRawProducts(parsed: unknown): unknown[] | undefined {
  const products = (parsed as Record<string, unknown> | null)?.products
  return Array.isArray(products) ? products : undefined
}

/** Pages through one products.json-shaped path via the headless browser, mirroring
 * `fetchShopifyProductsJson`'s pagination contract in `@hundi/cli/scanner`: stop at the
 * first non-full page or once the accumulated total hits `MAX_PRODUCTS`, dedupe by sku.
 * Returns an empty array (rather than throwing) the moment a page fails to fetch or
 * parse — a bot-gate that blocks even the browser, or a path that isn't Shopify's feed
 * at all, both look the same to the caller: "this path didn't work, try the next one." */
async function browserScanPath(
  origin: string,
  path: string,
  merchantId: string,
  warnings: string[],
): Promise<ScannedProduct[]> {
  const collected: ScannedProduct[] = []
  const seenSkus = new Set<string>()
  let sawUsablePage = false

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = `${origin}${path}?limit=${PAGE_LIMIT}&page=${page}`
    const text = await browserFetchText(pageUrl)
    if (!text) break

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      break
    }

    const rawProducts = extractRawProducts(parsed)
    if (rawProducts === undefined || rawProducts.length === 0) break
    sawUsablePage = true

    const extracted = extractShopifyProducts(parsed, pageUrl, merchantId)
    warnings.push(...extracted.warnings)
    for (const product of extracted.products) {
      if (seenSkus.has(product.sku)) continue
      seenSkus.add(product.sku)
      collected.push(product)
    }

    const pageWasFull = rawProducts.length >= PAGE_LIMIT
    if (!pageWasFull || collected.length >= MAX_PRODUCTS) break
  }

  return sawUsablePage ? collected.slice(0, MAX_PRODUCTS) : []
}

export type BrowserScanResult = { products: ScannedProduct[]; warnings: string[] }

/** Browser-driven fallback for Shopify's products.json feed: tries `/products.json`,
 * then `/collections/all/products.json`, returning the first path that yields any
 * products. Only meant to be called after the server-side scan (`scanStore`) has
 * already come back with zero usable products — see routes/stores.ts. */
export async function browserScanShopify(
  storeUrl: string,
  merchantId: string,
): Promise<BrowserScanResult> {
  const warnings: string[] = []
  let origin: string
  try {
    origin = new URL(storeUrl).origin
  } catch {
    return { products: [], warnings: [] }
  }

  for (const path of SHOPIFY_PRODUCTS_JSON_PATHS) {
    const products = await browserScanPath(origin, path, merchantId, warnings)
    if (products.length > 0) {
      warnings.push(
        `scanned via headless browser (server-side fetch was bot-blocked): ${products.length} products`,
      )
      return { products, warnings }
    }
  }

  return { products: [], warnings }
}
