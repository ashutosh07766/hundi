/**
 * GET /catalog/:merchant_id/upsell — deterministic, LLM-free complementary-
 * product ranking for one sku within one merchant's catalog. Backs the MCP
 * `get_upsell` tool: these are structured catalog data for a buyer brain to
 * consider, not instructions to execute, so nothing here runs a model over
 * merchant-authored text — a title crafted to look like an instruction is
 * just a string this ranker tokenizes, never a prompt.
 *
 * Registered ahead of `registerStoreRoutes` in app.ts for the same reason
 * catalog-search.ts is: Hono resolves overlapping routes in registration
 * order, and a literal path must be checked before the param route
 * (`/catalog/:merchant_id`) that could otherwise swallow it.
 */

import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { RouteError } from '../errors.js'
import type { FeedProduct } from '../feed-product.js'
import { getStoreCatalog } from '../store-catalog-repo.js'

const DEFAULT_LIMIT = 4
const MAX_LIMIT = 12

const BRAND_MATCH_SCORE = 10
const TOKEN_MATCH_SCORE = 3
const MIN_TOKEN_LENGTH = 3

/** Common words dropped before token-matching so two unrelated products don't
 * "match" purely on filler words like "the" or "with". */
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'this', 'that', 'set'])

function significantTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token)),
  )
}

/** Same-brand match plus each shared significant title token, once per token —
 * a candidate that matches on neither scores 0 and is dropped by the caller. */
function scoreComplement(
  base: FeedProduct,
  baseTokens: Set<string>,
  candidate: FeedProduct,
): number {
  let score = 0
  if (base.brand.length > 0 && base.brand.toLowerCase() === candidate.brand.toLowerCase()) {
    score += BRAND_MATCH_SCORE
  }
  for (const token of significantTokens(candidate.title)) {
    if (baseTokens.has(token)) score += TOKEN_MATCH_SCORE
  }
  return score
}

/** Ties break on id — arbitrary but fixed, so repeated identical requests can
 * never reorder results between runs. */
function compareRanked(
  a: { product: FeedProduct; score: number },
  b: { product: FeedProduct; score: number },
): number {
  if (b.score !== a.score) return b.score - a.score
  return a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0
}

/** Only non-negative bare-integer literals are accepted — same discipline
 * catalog-search.ts's `limit` param uses. */
function parseNonNegativeIntParam(raw: string | undefined, code: string): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new RouteError(400, code)
  return Number(raw)
}

export function registerUpsellRoute(app: Hono, { db }: AppDeps): void {
  app.get('/catalog/:merchant_id/upsell', (c) => {
    const merchantId = c.req.param('merchant_id')
    const sku = c.req.query('sku')
    if (sku === undefined || sku.trim().length === 0) throw new RouteError(400, 'INVALID_SKU')

    const row = getStoreCatalog(db, merchantId)
    if (!row) throw new RouteError(404, 'CATALOG_NOT_FOUND')

    const catalog = JSON.parse(row.catalog_json) as FeedProduct[]
    const base = catalog.find((p) => p.id === sku)
    if (!base) throw new RouteError(404, 'SKU_NOT_FOUND')

    const limitParam = parseNonNegativeIntParam(c.req.query('limit'), 'INVALID_LIMIT')
    const limit = Math.min(limitParam ?? DEFAULT_LIMIT, MAX_LIMIT)

    const baseTokens = significantTokens(base.title)
    const ranked = catalog
      .filter((p) => p.id !== sku && p.availability.status === 'in_stock')
      .map((product) => ({ product, score: scoreComplement(base, baseTokens, product) }))
      .filter((entry) => entry.score > 0)
      .sort(compareRanked)

    const results = ranked.slice(0, limit).map((entry) => entry.product)
    return c.json({ ok: true, sku, results, count: results.length }, 200)
  })
}
