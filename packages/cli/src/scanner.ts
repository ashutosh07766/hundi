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

export type ScannedProduct = {
  sku: string
  name: string
  description: string
  /** Integer paise, converted from the schema.org decimal-rupee price string
   * at parse time — every downstream consumer works in integers only. */
  price_paise: number
  currency: string
  availability: Availability
  image: string
  brand: string
  /** The page this product was extracted from — kept for traceability and as
   * the fallback source for a derived sku. */
  url: string
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

function deriveMerchantId(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  return hostname.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'merchant'
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

  return { merchant_id: deriveMerchantId(finalUrl), products: [...bySku.values()], warnings }
}
