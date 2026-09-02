/**
 * Cross-merchant catalog search: the one read route that fans out across every
 * onboarded store's `store_catalogs` row instead of a single merchant_id. An
 * agent shopping "for the cheapest X" has no reason to already know which
 * store carries it — this is the entry point that lets it search by intent
 * first and resolve to a merchant_id second.
 *
 * Ranking is a deterministic, LLM-free relevance score (see `scoreProduct`)
 * rather than a real search index: it's built for the handful of onboarded
 * stores this facilitator serves, not for catalog scale. A product with a
 * zero score (no match anywhere) is dropped rather than returned at the tail
 * of the list.
 *
 * Registered ahead of `registerStoreRoutes` in app.ts: Hono resolves
 * overlapping routes in registration order, and `/catalog/:merchant_id`
 * (a param route) would otherwise swallow the literal `/catalog/search`
 * path by treating "search" as a merchant_id.
 */

import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { RouteError } from '../errors.js'
import type { FeedProduct } from '../feed-product.js'
import { getStoreCatalog, listStoreCatalogs } from '../store-catalog-repo.js'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

/** Relative weight of a match in each field — title outranks brand outranks
 * description at every match tier, so a title match always scores above a
 * description-only match regardless of how many description tokens hit. */
const FIELD_WEIGHTS = { title: 3, brand: 2, description: 1 } as const

/**
 * Deterministic relevance score for one product against a query. No ML, no
 * external index — just case-insensitive exact/substring/token matching so
 * the same (query, catalog) pair always ranks identically.
 *
 *   - full-string exact match on a field:      weight * 10
 *   - full query as a substring of a field:    weight * 5
 *   - each individual query token present:     weight (once per token)
 *
 * A product that matches nowhere scores 0 and is filtered out by the caller.
 */
function scoreProduct(product: FeedProduct, queryLower: string, queryTokens: string[]): number {
  let score = 0
  for (const field of Object.keys(FIELD_WEIGHTS) as (keyof typeof FIELD_WEIGHTS)[]) {
    const weight = FIELD_WEIGHTS[field]
    const value = product[field]?.toLowerCase()
    if (!value) continue

    if (value === queryLower) {
      score += weight * 10
    } else if (value.includes(queryLower)) {
      score += weight * 5
    }

    for (const token of queryTokens) {
      if (value.includes(token)) score += weight
    }
  }
  return score
}

/** Ties (equal score) break on merchant_id then id — arbitrary but fixed, so
 * repeated identical requests can never reorder results between runs. */
function compareRanked(
  a: { product: FeedProduct; score: number },
  b: { product: FeedProduct; score: number },
): number {
  if (b.score !== a.score) return b.score - a.score
  if (a.product.merchant_id !== b.product.merchant_id) {
    return a.product.merchant_id < b.product.merchant_id ? -1 : 1
  }
  return a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0
}

/** Only non-negative bare-integer literals are accepted (no sign, no decimal,
 * no exponent) — same discipline read.ts's ledger `limit` uses, so a caller
 * can't smuggle in "1e9" or "-5" as a plausible-looking number. */
function parseNonNegativeIntParam(raw: string | undefined, code: string): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new RouteError(400, code)
  return Number(raw)
}

function loadCatalogProducts(deps: AppDeps, merchantId: string | undefined): FeedProduct[] {
  if (merchantId !== undefined) {
    const row = getStoreCatalog(deps.db, merchantId)
    return row ? (JSON.parse(row.catalog_json) as FeedProduct[]) : []
  }
  return listStoreCatalogs(deps.db).flatMap((row) => JSON.parse(row.catalog_json) as FeedProduct[])
}

export function registerCatalogSearchRoute(app: Hono, deps: AppDeps): void {
  app.get('/catalog/search', (c) => {
    const q = c.req.query('q')
    if (q === undefined || q.trim().length === 0) throw new RouteError(400, 'INVALID_QUERY')

    const merchantId = c.req.query('merchant_id')
    const maxPricePaise = parseNonNegativeIntParam(
      c.req.query('max_price_paise'),
      'INVALID_MAX_PRICE',
    )
    const limitParam = parseNonNegativeIntParam(c.req.query('limit'), 'INVALID_LIMIT')
    const limit = Math.min(limitParam ?? DEFAULT_LIMIT, MAX_LIMIT)
    const inStockOnly = c.req.query('in_stock') === 'true'

    const candidates = loadCatalogProducts(deps, merchantId).filter((p) => {
      if (maxPricePaise !== undefined && p.price_paise > maxPricePaise) return false
      if (inStockOnly && p.availability.status !== 'in_stock') return false
      return true
    })

    const queryLower = q.trim().toLowerCase()
    const queryTokens = queryLower.split(/\s+/).filter(Boolean)

    const ranked = candidates
      .map((product) => ({ product, score: scoreProduct(product, queryLower, queryTokens) }))
      .filter((entry) => entry.score > 0)
      .sort(compareRanked)

    const results = ranked.slice(0, limit).map((entry) => entry.product)
    return c.json({ ok: true, results, count: results.length }, 200)
  })
}
