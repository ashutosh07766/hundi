/**
 * Fetches and parses arbitrary third-party storefronts, so every outbound
 * request goes through `safeFetch`'s SSRF guards (private/loopback IP
 * rejection, redirect cap, timeout, body-size cap, http(s)-only) rather than
 * a bare `fetch`. `extractProducts` and `extractLinks` are pure — no I/O —
 * so parsing logic is testable against fixture HTML without a network.
 */

import { lookup } from 'node:dns/promises'
import { isPrivateOrLoopbackIp } from './ip-guard.js'

export type Availability = 'in_stock' | 'out_of_stock'

/** One purchasable SKU within a product (e.g. a specific size/color). Prices and
 * stock are per-variant — a product's own `price_paise`/`availability` reflect only
 * its first variant, so any consumer that needs to let a buyer pick a specific size
 * or color must read `variants`, not the product-level fields. */
export type ScannedVariant = {
  variant_id: string
  /** Shopify's own variant title (e.g. "11 / Black") — display-only. */
  label: string
  /** One value per product option, same order as `ScannedProduct.options` (e.g.
   * `["11", "Black"]` for options `[{name:"Size",...},{name:"Color",...}]`). */
  option_values: string[]
  price_paise: number
  available: boolean
  sku?: string
}

export type ScannedOption = { name: string; values: string[] }

export type ScannedProduct = {
  sku: string
  name: string
  description: string
  /** Integer paise, converted from the schema.org decimal-rupee price string
   * at parse time — every downstream consumer works in integers only. For a
   * multi-variant Shopify product this is the first variant's price (legacy
   * flat-catalog behavior); a consumer that needs a specific variant's price
   * must read `variants`. */
  price_paise: number
  currency: string
  availability: Availability
  image: string
  brand: string
  /** The page this product was extracted from — kept for traceability and as
   * the fallback source for a derived sku. */
  url: string
  /** Every purchasable variant, present only for a Shopify product with more than
   * one variant (a single "Default Title" variant carries no real size/color
   * choice, so it's left undefined rather than emitted as a one-item array — this
   * is what lets a consumer branch on "does this product have real options" with
   * a plain truthiness check). Absent entirely on the schema.org JSON-LD path,
   * which carries no variant data at all. */
  variants?: ScannedVariant[]
  /** The product-level option definitions (e.g. `[{name:"Size",values:["9","10","11"]}]`)
   * a Shopify product's variants are built from. Same presence rule as `variants`. */
  options?: ScannedOption[]
}

export type ScanResult = {
  merchant_id: string
  products: ScannedProduct[]
  warnings: string[]
}

export type ResolvedAddress = { address: string; family: number }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

const defaultResolver: Resolver = (hostname) => lookup(hostname, { all: true })

export class ScanError extends Error {
  override readonly name = 'ScanError'
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_PRODUCT_PAGES = 25

export type SafeFetchOptions = {
  resolver?: Resolver
  maxRedirects?: number
  timeoutMs?: number
  maxBodyBytes?: number
}

export type SafeFetchResult = { text: string; finalUrl: string }

async function assertPublicHost(hostname: string, resolver: Resolver): Promise<void> {
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolver(hostname)
  } catch {
    throw new ScanError(`could not resolve host: ${hostname}`)
  }
  if (addresses.length === 0) throw new ScanError(`could not resolve host: ${hostname}`)
  for (const { address } of addresses) {
    if (isPrivateOrLoopbackIp(address)) {
      throw new ScanError(`refusing to fetch private/loopback address: ${hostname} -> ${address}`)
    }
  }
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return await res.text()

  const decoder = new TextDecoder()
  let received = 0
  let result = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new ScanError(`response body exceeded ${maxBytes}-byte cap`)
    }
    result += decoder.decode(value, { stream: true })
  }
  result += decoder.decode()
  return result
}

/** SSRF-safe fetch: rejects non-http(s) protocols, re-resolves and re-checks
 * every redirect hop against private/loopback ranges (redirects followed
 * manually so a 302 can't bounce the request into an internal address), and
 * caps redirect count, wall-clock time, and response body size. Every
 * outbound request the CLI makes goes through this — the target is always a
 * merchant-supplied URL, never a fixed trusted host. */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const resolver = options.resolver ?? defaultResolver
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  let currentUrl = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(currentUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ScanError(`refusing to fetch non-http(s) URL: ${currentUrl}`)
    }
    await assertPublicHost(parsed.hostname, resolver)

    const res = await fetch(currentUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })

    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === maxRedirects) throw new ScanError(`too many redirects fetching ${url}`)
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    if (!res.ok) throw new ScanError(`fetch failed (${res.status}) for ${currentUrl}`)

    const text = await readBodyCapped(res, maxBodyBytes)
    return { text, finalUrl: currentUrl }
  }
  throw new ScanError(`too many redirects fetching ${url}`)
}

// ---------------------------------------------------------------------------
// Pure JSON-LD extraction — no I/O, safe to unit test against fixture HTML.
// ---------------------------------------------------------------------------

const JSON_LD_BLOCK_RE =
  /<script[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
const ANCHOR_HREF_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi

function isProductType(type: unknown): boolean {
  if (typeof type === 'string') return type === 'Product'
  if (Array.isArray(type)) return type.includes('Product')
  return false
}

/** Walks a parsed JSON-LD document collecting every `Product` node, handling
 * the three shapes stores commonly emit: a single object, a bare array of
 * objects, and a wrapper object with an `@graph` array. */
function collectProductNodes(root: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (isProductType(obj['@type'])) out.push(obj)
    if (Array.isArray(obj['@graph'])) visit(obj['@graph'])
  }
  visit(root)
  return out
}

function pickOffer(raw: unknown): Record<string, unknown> | undefined {
  const candidates = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : []
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate as Record<string, unknown>
  }
  return undefined
}

function toPaise(price: unknown): number | undefined {
  if (typeof price === 'number' && Number.isFinite(price)) return Math.round(price * 100)
  if (typeof price === 'string') {
    const n = Number.parseFloat(price)
    return Number.isFinite(n) ? Math.round(n * 100) : undefined
  }
  return undefined
}

function mapAvailability(raw: unknown): Availability {
  const value = typeof raw === 'string' ? raw.toLowerCase() : ''
  const outOfStockMarkers = ['outofstock', 'soldout', 'discontinued', 'backorder']
  return outOfStockMarkers.some((marker) => value.includes(marker)) ? 'out_of_stock' : 'in_stock'
}

function normalizeBrand(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).name === 'string') {
    return (raw as Record<string, unknown>).name as string
  }
  return ''
}

function normalizeSku(node: Record<string, unknown>): string | undefined {
  const candidate = node.sku ?? node.productID ?? node.mpn
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

function deriveSkuFromUrl(url: string): string {
  const { pathname } = new URL(url)
  const segments = pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? 'product'
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return slug || 'product'
}

function normalizeImage(raw: unknown, baseUrl: string, name: string, warnings: string[]): string {
  let candidate: string | undefined
  if (typeof raw === 'string') {
    candidate = raw
  } else if (Array.isArray(raw)) {
    candidate = raw.find((v): v is string => typeof v === 'string')
  } else if (
    raw &&
    typeof raw === 'object' &&
    typeof (raw as Record<string, unknown>).url === 'string'
  ) {
    candidate = (raw as Record<string, unknown>).url as string
  }
  if (!candidate) return ''

  let resolved: URL
  try {
    resolved = new URL(candidate, baseUrl)
  } catch {
    return candidate
  }
  if (!/^https?:\/\//i.test(candidate)) {
    warnings.push(
      `normalized relative image URL for "${name}": ${candidate} -> ${resolved.toString()}`,
    )
  }
  return resolved.toString()
}

function buildProduct(
  node: Record<string, unknown>,
  baseUrl: string,
  warnings: string[],
): ScannedProduct | undefined {
  const name = typeof node.name === 'string' ? node.name : undefined
  if (!name) {
    warnings.push(`product missing name on ${baseUrl}, skipped`)
    return undefined
  }

  const offer = pickOffer(node.offers)
  const pricePaise = offer ? toPaise(offer.price) : undefined
  if (pricePaise === undefined) {
    warnings.push(`missing price for "${name}" on ${baseUrl}, skipped`)
    return undefined
  }

  let sku = normalizeSku(node)
  if (!sku) {
    sku = deriveSkuFromUrl(baseUrl)
    warnings.push(`missing sku for "${name}", derived "${sku}" from URL`)
  }

  const currency = typeof offer?.priceCurrency === 'string' ? offer.priceCurrency : undefined
  if (!currency) {
    warnings.push(`missing priceCurrency for "${name}", defaulting to INR`)
  }

  return {
    sku,
    name,
    description: typeof node.description === 'string' ? node.description : '',
    price_paise: pricePaise,
    currency: currency ?? 'INR',
    availability: mapAvailability(offer?.availability),
    image: normalizeImage(node.image, baseUrl, name, warnings),
    brand: normalizeBrand(node.brand),
    url: baseUrl,
  }
}

/** Extracts every schema.org `Product` from a single page's HTML. Pure — no
 * fetch, no dependence on the caller having navigated anywhere — so tests can
 * exercise it directly against fixture strings. */
export function extractProducts(
  html: string,
  baseUrl: string,
): { products: ScannedProduct[]; warnings: string[] } {
  const warnings: string[] = []
  const products: ScannedProduct[] = []
  const blocks = [...html.matchAll(JSON_LD_BLOCK_RE)]

  if (blocks.length === 0) {
    warnings.push(`no JSON-LD found on ${baseUrl}`)
    return { products, warnings }
  }

  for (const block of blocks) {
    const raw = block[1]
    if (raw === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.trim())
    } catch {
      warnings.push(`malformed JSON-LD block on ${baseUrl}`)
      continue
    }
    for (const node of collectProductNodes(parsed)) {
      const built = buildProduct(node, baseUrl, warnings)
      if (built) products.push(built)
    }
  }

  if (products.length === 0 && blocks.length > 0) {
    warnings.push(`no products found in JSON-LD on ${baseUrl}`)
  }

  return { products, warnings }
}

/** Same-origin links out of a page, deduped and hash-stripped, in document
 * order. Used to sample linked product pages when the scanned URL is an
 * index/listing rather than a single product page. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl)
  const seen = new Set<string>([base.toString()])
  const links: string[] = []

  for (const match of html.matchAll(ANCHOR_HREF_RE)) {
    const href = match[1]
    if (!href) continue
    let resolved: URL
    try {
      resolved = new URL(href, base)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    if (resolved.origin !== base.origin) continue
    resolved.hash = ''
    const normalized = resolved.toString()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    links.push(normalized)
  }
  return links
}

// ---------------------------------------------------------------------------
// Pure Shopify products.json mapping — no I/O, safe to unit test against
// fixture JSON.
// ---------------------------------------------------------------------------

const HTML_TAG_RE = /<[^>]*>/g
const SHOPIFY_DESCRIPTION_MAX_CHARS = 300

function stripHtml(raw: string): string {
  return raw.replace(HTML_TAG_RE, ' ').replace(/\s+/g, ' ').trim()
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text
}

/** Maps a Shopify product's `options` array (`[{name:"Size",values:["9","10"]}]`)
 * onto `ScannedOption[]`, dropping any entry missing a usable name. Returns
 * `undefined` for a missing/malformed/empty array so callers can gate on
 * presence with a plain truthiness check. */
function buildScannedOptions(raw: unknown): ScannedOption[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const options: ScannedOption[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (typeof obj.name !== 'string' || obj.name.length === 0) continue
    const values = Array.isArray(obj.values)
      ? obj.values.filter((v): v is string => typeof v === 'string')
      : []
    options.push({ name: obj.name, values })
  }
  return options.length > 0 ? options : undefined
}

/** Maps a Shopify product's raw `variants[]` onto `ScannedVariant[]`, reading
 * `option1`/`option2`/`option3` into `option_values` (Shopify's own variant shape
 * carries options positionally, not as named fields). A variant missing a usable
 * id or price is dropped rather than aborting the whole product. Returns
 * `undefined` when fewer than two usable variants remain — a lone "Default
 * Title" variant carries no real size/color choice, so it collapses to the
 * legacy flat-product shape instead of a one-item variants array. */
function buildScannedVariants(raw: Record<string, unknown>[]): ScannedVariant[] | undefined {
  const variants: ScannedVariant[] = []
  for (const variant of raw) {
    const id = variant.id
    const variantId = typeof id === 'number' || typeof id === 'string' ? String(id) : undefined
    const price = toPaise(variant.price)
    if (!variantId || price === undefined) continue

    const optionValues = [variant.option1, variant.option2, variant.option3].filter(
      (v): v is string => typeof v === 'string',
    )
    const label =
      typeof variant.title === 'string' && variant.title.length > 0
        ? variant.title
        : optionValues.join(' / ') || variantId
    const sku = typeof variant.sku === 'string' && variant.sku.length > 0 ? variant.sku : undefined

    variants.push({
      variant_id: variantId,
      label,
      option_values: optionValues,
      price_paise: price,
      available: variant.available === true,
      ...(sku ? { sku } : {}),
    })
  }
  return variants.length > 1 ? variants : undefined
}

/** Maps Shopify's `/products.json` storefront feed onto the scanner's product
 * shape. Every Shopify store exposes this feed regardless of theme, unlike
 * schema.org JSON-LD, which many themes omit entirely — this is the fallback
 * that makes the scanner work on the broad population of Shopify merchants.
 * Pure — no fetch — so tests exercise it directly against fixture JSON.
 *
 * The feed carries no currency field; prices are denominated in the store's
 * storefront currency, and every scanned store here is assumed Indian, so
 * currency is hardcoded to INR rather than inferred. */
export function extractShopifyProducts(
  json: unknown,
  baseUrl: string,
  merchantId: string,
): { products: ScannedProduct[]; warnings: string[] } {
  const warnings: string[] = []
  const products: ScannedProduct[] = []

  if (
    !json ||
    typeof json !== 'object' ||
    !Array.isArray((json as Record<string, unknown>).products)
  ) {
    return { products, warnings }
  }

  const rawProducts = (json as { products: unknown[] }).products
  const base = new URL(baseUrl)

  for (const raw of rawProducts) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as Record<string, unknown>

    const title = typeof node.title === 'string' ? node.title.trim() : ''
    if (!title) {
      warnings.push(`shopify product missing title on ${baseUrl}, skipped`)
      continue
    }

    const variants = Array.isArray(node.variants)
      ? (node.variants as Record<string, unknown>[])
      : []
    const variant = variants[0]
    if (!variant) {
      warnings.push(`shopify product "${title}" has no variants, skipped`)
      continue
    }

    const pricePaise = toPaise(variant.price)
    if (pricePaise === undefined || pricePaise <= 0) {
      warnings.push(`shopify product "${title}" has no usable price, skipped`)
      continue
    }

    const handle =
      typeof node.handle === 'string' && node.handle.length > 0 ? node.handle : undefined
    const variantSku =
      typeof variant.sku === 'string' && variant.sku.length > 0 ? variant.sku : undefined
    // Handle is Shopify's stable, always-present, always-unique slug — prefer
    // it over variant sku, which merchants sometimes leave blank.
    const sku = handle ?? variantSku
    if (!sku) {
      warnings.push(`shopify product "${title}" has no handle or sku, skipped`)
      continue
    }

    const images = Array.isArray(node.images) ? (node.images as Record<string, unknown>[]) : []
    const image = typeof images[0]?.src === 'string' ? (images[0].src as string) : ''

    const description =
      typeof node.body_html === 'string' && node.body_html.length > 0
        ? truncate(stripHtml(node.body_html), SHOPIFY_DESCRIPTION_MAX_CHARS)
        : ''

    const scannedVariants = buildScannedVariants(variants)
    const scannedOptions = scannedVariants ? buildScannedOptions(node.options) : undefined

    products.push({
      sku,
      name: title,
      description,
      price_paise: pricePaise,
      currency: 'INR',
      availability: variant.available === true ? 'in_stock' : 'out_of_stock',
      image,
      brand: typeof node.vendor === 'string' && node.vendor.length > 0 ? node.vendor : merchantId,
      url: handle ? new URL(`/products/${handle}`, base).toString() : baseUrl,
      ...(scannedVariants ? { variants: scannedVariants } : {}),
      ...(scannedOptions ? { options: scannedOptions } : {}),
    })
  }

  return { products, warnings }
}

export function deriveMerchantId(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  return hostname.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'merchant'
}

const SHOPIFY_PRODUCTS_JSON_PATHS = ['/products.json', '/collections/all/products.json']
const SHOPIFY_PRODUCTS_JSON_LIMIT = 250
const SHOPIFY_PRODUCTS_JSON_MAX_PAGES = 3
const SHOPIFY_PRODUCTS_JSON_MAX_PRODUCTS = 500

/** Tries Shopify's `/products.json` feed, falling back to
 * `/collections/all/products.json` if the first path yields nothing (some
 * storefronts gate the bare path but leave the collection one open). Pages
 * through up to `SHOPIFY_PRODUCTS_JSON_MAX_PAGES` pages of
 * `SHOPIFY_PRODUCTS_JSON_LIMIT` each, stopping at the first non-full page or
 * once the accumulated total reaches `SHOPIFY_PRODUCTS_JSON_MAX_PRODUCTS`, so
 * a single scan stays bounded regardless of catalog size. A 404, a non-JSON
 * body, or a JSON body without a `products` array is treated as "this path
 * isn't Shopify's feed" rather than an error — the caller falls through to
 * the empty-result case exactly as if no fallback had been attempted. */
async function fetchShopifyProductsJson(
  origin: string,
  merchantId: string,
  fetchOptions: SafeFetchOptions,
  warnings: string[],
): Promise<ScannedProduct[]> {
  for (const path of SHOPIFY_PRODUCTS_JSON_PATHS) {
    const collected: ScannedProduct[] = []
    const seenSkus = new Set<string>()
    let sawUsablePage = false

    for (let page = 1; page <= SHOPIFY_PRODUCTS_JSON_MAX_PAGES; page++) {
      const pageUrl = `${origin}${path}?limit=${SHOPIFY_PRODUCTS_JSON_LIMIT}&page=${page}`

      let text: string
      try {
        text = (await safeFetch(pageUrl, fetchOptions)).text
      } catch {
        break
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        break
      }

      const rawProducts = Array.isArray((parsed as Record<string, unknown> | null)?.products)
        ? (parsed as { products: unknown[] }).products
        : undefined
      if (rawProducts === undefined || rawProducts.length === 0) break
      sawUsablePage = true

      const extracted = extractShopifyProducts(parsed, pageUrl, merchantId)
      warnings.push(...extracted.warnings)
      for (const product of extracted.products) {
        if (seenSkus.has(product.sku)) continue
        seenSkus.add(product.sku)
        collected.push(product)
      }

      const pageWasFull = rawProducts.length >= SHOPIFY_PRODUCTS_JSON_LIMIT
      if (!pageWasFull || collected.length >= SHOPIFY_PRODUCTS_JSON_MAX_PRODUCTS) break
    }

    if (sawUsablePage && collected.length > 0) {
      return collected.slice(0, SHOPIFY_PRODUCTS_JSON_MAX_PRODUCTS)
    }
  }

  return []
}

export type ScanOptions = {
  resolver?: Resolver
  maxProductPages?: number
}

/** Fetches `url`, extracts any products embedded on that page directly, then
 * samples same-origin links (capped at `maxProductPages`) for additional
 * product pages — covers both "URL is already a product page" and "URL is a
 * category/home page linking out to products" without the caller having to
 * know which shape a given store uses. Per-link fetch failures are recorded
 * as warnings rather than aborting the whole scan. */
export async function scanStore(url: string, options: ScanOptions = {}): Promise<ScanResult> {
  const maxProductPages = options.maxProductPages ?? MAX_PRODUCT_PAGES
  const warnings: string[] = []
  const bySku = new Map<string, ScannedProduct>()
  const fetchOptions: SafeFetchOptions = options.resolver ? { resolver: options.resolver } : {}

  const { text: html, finalUrl } = await safeFetch(url, fetchOptions)

  const direct = extractProducts(html, finalUrl)
  for (const product of direct.products) bySku.set(product.sku, product)
  warnings.push(...direct.warnings)

  const links = extractLinks(html, finalUrl).slice(0, maxProductPages)
  for (const link of links) {
    let pageHtml: string
    try {
      pageHtml = (await safeFetch(link, fetchOptions)).text
    } catch (err) {
      warnings.push(`failed to fetch ${link}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const extracted = extractProducts(pageHtml, link)
    for (const product of extracted.products) {
      if (!bySku.has(product.sku)) bySku.set(product.sku, product)
    }
    // A linked page with no JSON-LD at all (footer/about/cart links) is
    // expected noise from link-sampling, not a scan problem worth surfacing.
    for (const warning of extracted.warnings) {
      if (!warning.startsWith('no JSON-LD found')) warnings.push(warning)
    }
  }

  const merchantId = deriveMerchantId(finalUrl)

  // No schema.org Product markup anywhere on the page or its sampled links —
  // fall back to Shopify's products.json feed, which is present on the vast
  // majority of Shopify storefronts independent of theme.
  if (bySku.size === 0) {
    const origin = new URL(finalUrl).origin
    const shopifyProducts = await fetchShopifyProductsJson(
      origin,
      merchantId,
      fetchOptions,
      warnings,
    )
    if (shopifyProducts.length > 0) {
      for (const product of shopifyProducts) bySku.set(product.sku, product)
      warnings.push(
        `used Shopify products.json fallback: ${shopifyProducts.length} products (no schema.org JSON-LD found)`,
      )
    }
  }

  return { merchant_id: merchantId, products: [...bySku.values()], warnings }
}
