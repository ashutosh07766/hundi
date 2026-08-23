/**
 * Persistence for `store_catalogs` — the agent-feed-shape product list backing
 * GET /catalog/:merchant_id and GET /stores. Upserts on merchant_id, unlike
 * the create-only `merchants` table: a store's real catalog legitimately
 * changes between scans, so the latest onboarding scan always replaces the
 * previous one rather than being rejected as a duplicate.
 */

import type Database from 'better-sqlite3'
import type { FeedProduct } from './feed-product.js'

export type StoreCatalogRow = {
  merchant_id: string
  name: string
  source_url: string | null
  product_count: number
  catalog_json: string
  created_at: number
}

export function upsertStoreCatalog(
  db: Database.Database,
  args: { merchantId: string; name: string; sourceUrl: string | null; products: FeedProduct[] },
): void {
  db.prepare(
    `INSERT INTO store_catalogs (merchant_id, name, source_url, product_count, catalog_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       name = excluded.name,
       source_url = excluded.source_url,
       product_count = excluded.product_count,
       catalog_json = excluded.catalog_json`,
  ).run(
    args.merchantId,
    args.name,
    args.sourceUrl,
    args.products.length,
    JSON.stringify(args.products),
  )
}

export function getStoreCatalog(
  db: Database.Database,
  merchantId: string,
): StoreCatalogRow | undefined {
  return db
    .prepare(
      'SELECT merchant_id, name, source_url, product_count, catalog_json, created_at FROM store_catalogs WHERE merchant_id = ?',
    )
    .get(merchantId) as StoreCatalogRow | undefined
}

export function listStoreCatalogs(db: Database.Database): StoreCatalogRow[] {
  return db
    .prepare(
      'SELECT merchant_id, name, source_url, product_count, catalog_json, created_at FROM store_catalogs ORDER BY created_at DESC',
    )
    .all() as StoreCatalogRow[]
}

/** Upserts the `merchants` row backing verifyChain's PRICE_MISMATCH / merchant-scope
 * checks (see verify-logic.ts). Unlike POST /admin/merchants (create-only — see
 * routes/admin.ts), onboarding a store legitimately re-registers the same merchant_id
 * on every re-scan, so this always overwrites rather than 409ing. */
export function upsertMerchant(
  db: Database.Database,
  args: {
    merchantId: string
    name: string
    catalogUrl: string | null
    catalogPrices: Record<string, number>
  },
): void {
  db.prepare(
    `INSERT INTO merchants (merchant_id, name, catalog_url, config_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       name = excluded.name,
       catalog_url = excluded.catalog_url,
       config_json = excluded.config_json`,
  ).run(
    args.merchantId,
    args.name,
    args.catalogUrl,
    JSON.stringify({ catalogPrices: args.catalogPrices }),
  )
}
