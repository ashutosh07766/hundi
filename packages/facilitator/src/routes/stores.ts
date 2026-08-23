/**
 * Store onboarding + catalog-serving. Lets a non-technical operator paste a
 * real store URL from the dashboard and get a shoppable, mandate-scoped
 * catalog without touching a terminal: POST /stores/onboard scans the URL
 * (via the SSRF-safe `@hundi/cli/scanner`), registers/updates the merchant
 * and its catalog, and GET /catalog/:merchant_id serves that catalog back in
 * the agent-feed shape apps/dashboard's buyer.ts expects. Routing every
 * catalog fetch through the facilitator — keyed on merchant_id, never a raw
 * store URL — is what ties the shopped catalog to a mandate's merchant
 * automatically: there is no separate "store URL" for the buyer to get out
 * of sync with the mandate's scope.
 */

import { zValidator } from '@hono/zod-validator'
import { scanStore as defaultScanStore } from '@hundi/cli/scanner'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { tx } from '../db/index.js'
import { buildPoisonProduct, toFeedProducts } from '../feed-product.js'
import { requireHeaderToken } from '../middleware.js'
import { storesOnboardBodySchema } from '../schemas.js'
import {
  getStoreCatalog,
  listStoreCatalogs,
  upsertMerchant,
  upsertStoreCatalog,
} from '../store-catalog-repo.js'

function deriveStoreName(finalUrl: string, fallback: string): string {
  try {
    return new URL(finalUrl).hostname.replace(/^www\./, '') || fallback
  } catch {
    return fallback
  }
}

export function registerStoreRoutes(app: Hono, deps: AppDeps): void {
  const { db, env } = deps
  const scan = deps.scanStore ?? defaultScanStore

  app.post(
    '/stores/onboard',
    requireHeaderToken('x-hundi-dashboard-token', env.DASHBOARD_TOKEN),
    zValidator('json', storesOnboardBodySchema),
    async (c) => {
      const { url } = c.req.valid('json')

      let scanResult: Awaited<ReturnType<typeof scan>>
      try {
        scanResult = await scan(url)
      } catch (err) {
        return c.json(
          {
            ok: false,
            error: 'SCAN_FAILED',
            detail: err instanceof Error ? err.message : String(err),
          },
          200,
        )
      }

      const products = toFeedProducts(scanResult)
      if (products.length === 0) {
        return c.json(
          {
            ok: false,
            error: 'NO_PRODUCTS',
            detail: 'store has no usable schema.org product markup',
          },
          200,
        )
      }

      const merchantId = scanResult.merchant_id
      const name = deriveStoreName(url, merchantId)
      const catalogPrices: Record<string, number> = {}
      for (const p of products) catalogPrices[p.id] = p.price_paise

      tx(db, () => {
        upsertMerchant(db, { merchantId, name, catalogUrl: url, catalogPrices })
        upsertStoreCatalog(db, { merchantId, name, sourceUrl: url, products })
      })

      return c.json(
        {
          ok: true,
          merchant_id: merchantId,
          name,
          product_count: products.length,
          sample: products.slice(0, 5).map((p) => p.title),
        },
        200,
      )
    },
  )

  app.get('/stores', (c) => {
    const stores = listStoreCatalogs(db).map((row) => ({
      merchant_id: row.merchant_id,
      name: row.name,
      product_count: row.product_count,
      source_url: row.source_url,
    }))
    return c.json({ ok: true, stores }, 200)
  })

  app.get('/catalog/:merchant_id', (c) => {
    const merchantId = c.req.param('merchant_id')
    const row = getStoreCatalog(db, merchantId)
    if (!row) return c.json({ ok: false, error: 'CATALOG_NOT_FOUND' }, 404)

    const products = JSON.parse(row.catalog_json) as ReturnType<typeof toFeedProducts>
    const poisoned = c.req.query('poisoned') === '1'
    return c.json(poisoned ? [...products, buildPoisonProduct(products)] : products, 200)
  })
}
