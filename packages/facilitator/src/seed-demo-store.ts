/**
 * Seeds the built-in demo store (apps/store) into `store_catalogs` at boot,
 * so GET /catalog/:merchant_id is the *one* code path every buyer.ts catalog
 * fetch goes through — onboarded real stores and the demo store alike —
 * instead of the demo store needing a special case in the dashboard.
 *
 * Best-effort: the demo store is a separate local process that may not be
 * running yet (or ever, in an environment that only cares about real-store
 * onboarding). A failed seed logs a visible warning and leaves demo-store-1
 * simply absent from GET /stores — never a facilitator boot failure, and
 * never a fabricated catalog.
 */

import type Database from 'better-sqlite3'
import type { FeedProduct } from './feed-product.js'
import { upsertStoreCatalog } from './store-catalog-repo.js'

export const DEMO_MERCHANT_ID = 'demo-store-1'
export const DEMO_STORE_NAME = 'Hundi Demo Store'

export async function seedDemoStoreCatalog(db: Database.Database, storeUrl: string): Promise<void> {
  let products: FeedProduct[]
  try {
    const res = await fetch(`${storeUrl.replace(/\/$/, '')}/api/catalog`)
    if (!res.ok) throw new Error(`status ${res.status}`)
    products = (await res.json()) as FeedProduct[]
  } catch (err) {
    console.warn(
      `[seed-demo-store] could not reach demo store at ${storeUrl} — demo-store-1 will be absent from GET /stores until it seeds successfully. (${err instanceof Error ? err.message : String(err)})`,
    )
    return
  }

  upsertStoreCatalog(db, {
    merchantId: DEMO_MERCHANT_ID,
    name: DEMO_STORE_NAME,
    sourceUrl: storeUrl,
    products,
  })
}
