/**
 * Facilitator client for store onboarding and the shoppable-store list.
 * Takes `facilitatorUrl` explicitly rather than reading the FACILITATOR_URL
 * module constant, matching buyer.ts's style — keeps this module's network
 * calls parameterized instead of hardwired to one origin.
 *
 * Fail-loud, matching api.ts's contract: a non-2xx response throws ApiError.
 * `onboardStore`'s own `{ ok: false, error: 'NO_PRODUCTS' | 'SCAN_FAILED' }`
 * responses are NOT thrown — they're genuine scan outcomes (the store URL
 * was reachable but had nothing usable, or the scan itself failed) that the
 * Stores tab renders inline, the same way a rejected/blocked settlement is a
 * normal `runTestPurchase` result rather than a thrown error.
 */

import { ApiError } from './api.js'

function trimSlash(url: string): string {
  return url.replace(/\/$/, '')
}

export type OnboardStoreResult =
  | { ok: true; merchant_id: string; name: string; product_count: number; sample: string[] }
  | { ok: false; error: 'NO_PRODUCTS' | 'SCAN_FAILED'; detail: string }

/** POST /stores/onboard — scans `url`, registers/updates the merchant and its
 * catalog, and returns a preview. Dashboard-token-gated, like /ceremony-tokens. */
export async function onboardStore(
  facilitatorUrl: string,
  dashboardToken: string,
  url: string,
): Promise<OnboardStoreResult> {
  let res: Response
  try {
    res = await fetch(`${trimSlash(facilitatorUrl)}/stores/onboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hundi-dashboard-token': dashboardToken },
      body: JSON.stringify({ url }),
    })
  } catch (err) {
    throw new ApiError(
      `Network error calling /stores/onboard: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ApiError(
      `/stores/onboard returned a non-JSON response (status ${res.status})`,
      res.status,
    )
  }

  if (!res.ok) {
    const err = body as { error?: string; detail?: string }
    const detail = err.detail ? ` — ${err.detail}` : ''
    throw new ApiError(
      `/stores/onboard failed: ${err.error ?? res.statusText}${detail}`,
      res.status,
    )
  }
  return body as OnboardStoreResult
}

export type StoreListItem = {
  merchant_id: string
  name: string
  product_count: number
  source_url: string | null
}

/** GET /stores — every onboarded store plus the built-in demo store, newest first. */
export async function listStores(facilitatorUrl: string): Promise<StoreListItem[]> {
  let res: Response
  try {
    res = await fetch(`${trimSlash(facilitatorUrl)}/stores`)
  } catch (err) {
    throw new ApiError(
      `Network error calling /stores: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new ApiError(`/stores returned a non-JSON response (status ${res.status})`, res.status)
  }

  const body = json as
    | { ok: true; stores: StoreListItem[] }
    | { ok: false; error: string; detail?: string }
  if (!res.ok || body.ok === false) {
    const err = body as { error: string; detail?: string }
    const detail = err.detail ? ` — ${err.detail}` : ''
    throw new ApiError(`/stores failed: ${err.error ?? res.statusText}${detail}`, res.status)
  }
  return body.stores
}
