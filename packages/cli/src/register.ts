/**
 * Registers a scanned merchant with a Hundi facilitator via
 * `POST /admin/merchants` (see `packages/facilitator/src/routes/admin.ts`).
 * That route is create-only — a merchant_id can only be registered once, so
 * a second `hundi init --register` run against the same store is expected
 * and must not be treated as a failure.
 */

import type { ScanResult } from './scanner.js'

export type RegisterMerchantArgs = {
  facilitatorUrl: string
  adminToken: string
  store: ScanResult
}

export type RegisterMerchantResult = {
  ok: true
  status: 'registered' | 'already_registered'
}

export async function registerMerchant({
  facilitatorUrl,
  adminToken,
  store,
}: RegisterMerchantArgs): Promise<RegisterMerchantResult> {
  const catalogPrices: Record<string, number> = {}
  for (const product of store.products) catalogPrices[product.sku] = product.price_paise

  const res = await fetch(new URL('/admin/merchants', facilitatorUrl).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hundi-admin-token': adminToken,
    },
    body: JSON.stringify({
      merchant_id: store.merchant_id,
      name: store.merchant_id,
      config: { catalogPrices },
    }),
  })

  if (res.status === 409) return { ok: true, status: 'already_registered' }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`failed to register merchant (${res.status}): ${detail}`)
  }
  return { ok: true, status: 'registered' }
}
