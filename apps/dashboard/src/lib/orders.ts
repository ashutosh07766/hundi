/**
 * Order/receipt read path: the settlements list, a single settlement's full
 * detail (cart, payment attempts, approval, ledger), and the sku->title
 * catalog lookup a receipt needs to show a product name instead of a bare
 * sku. Takes `facilitatorUrl` explicitly (matching stores.ts, buyer.ts)
 * rather than the module `FACILITATOR_URL` constant, so these fetchers stay
 * testable without mocking config.
 *
 * Fail-loud, matching api.ts's contract: a non-2xx response or an explicit
 * `{ ok: false }` envelope throws ApiError. GET /catalog/:merchant_id has no
 * envelope (it's a bare array on success) so it only fails on non-2xx.
 */

import type { CartMandate, IntentMandate } from '@hundi/core'
import { ApiError, type MandateListItem } from './api.js'
import type { StoreProduct } from './buyer.js'
import type { LedgerEventType } from './narration.js'

function trimSlash(url: string): string {
  return url.replace(/\/$/, '')
}

async function getJson<T>(facilitatorUrl: string, path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${trimSlash(facilitatorUrl)}${path}`)
  } catch (err) {
    throw new ApiError(
      `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new ApiError(`${path} returned a non-JSON response (status ${res.status})`, res.status)
  }
  const body = json as { ok?: boolean; error?: string; detail?: string }
  if (!res.ok || body.ok === false) {
    const detail = body.detail ? ` — ${body.detail}` : ''
    throw new ApiError(`${path} failed: ${body.error ?? res.statusText}${detail}`, res.status)
  }
  return json as T
}

export type SettlementListItem = {
  id: string
  mandate_id: string
  state: string
  amount_paise: number
  merchant_id: string
  mandate_cart_hash_hex: string
  cart_json: string
  created_at: number
  reject_reason: string | null
}

/** GET /settlements — every settlement this facilitator has created, newest first. */
export async function fetchSettlements(facilitatorUrl: string): Promise<SettlementListItem[]> {
  const { settlements } = await getJson<{ settlements: SettlementListItem[] }>(
    facilitatorUrl,
    '/settlements',
  )
  return settlements
}

export type SettlementDetail = SettlementListItem & {
  verifying_at: number | null
  verified_at: number | null
  pending_approval_at: number | null
  approved_at: number | null
  settling_at: number | null
  captured_at: number | null
  failed_at: number | null
  rejected_at: number | null
  abandoned_at: number | null
  kick_count: number
}

export type SettlementAttempt = {
  id: string
  settlement_id: string
  method: 's2s_api' | 'checkout_driver' | 'payment_link'
  state: 'initiated' | 'awaiting_confirmation' | 'captured' | 'failed' | 'superseded'
  receipt: string
  provider_order_id: string | null
  provider_payment_id: string | null
  provider_link_id: string | null
  created_at: number
  updated_at: number
}

export type SettlementApproval = {
  settlement_id: string
  decision: 'approved' | 'rejected'
  mandate_cart_hash_hex: string
  sig_json: string
  decided_at: number
  expires_at: number
}

/** Raw ledger row shape as GET /settlements/:id embeds it — unlike GET
 * /ledger, this endpoint does not JSON.parse `payload` server-side, so
 * callers must parse it themselves (see `parseLedgerEvent`). */
export type RawLedgerEventRow = {
  seq: number
  event_type: string
  settlement_id: string | null
  actor: string
  payload: string
  prev_hash: string
  row_hash: string
  created_at: number
}

export type SettlementDetailResponse = {
  settlement: SettlementDetail
  attempts: SettlementAttempt[]
  approval: SettlementApproval | null
  ledger: RawLedgerEventRow[]
}

/** GET /settlements/:id — full receipt data for one settlement. */
export async function fetchSettlement(
  facilitatorUrl: string,
  id: string,
): Promise<SettlementDetailResponse> {
  const { settlement, attempts, approval, ledger } = await getJson<
    { ok: true } & SettlementDetailResponse
  >(facilitatorUrl, `/settlements/${encodeURIComponent(id)}`)
  return { settlement, attempts, approval, ledger }
}

/** GET /catalog/:merchant_id — same normalized feed shape buyer.ts shops from. */
export async function fetchCatalog(
  facilitatorUrl: string,
  merchantId: string,
): Promise<StoreProduct[]> {
  return getJson<StoreProduct[]>(facilitatorUrl, `/catalog/${encodeURIComponent(merchantId)}`)
}

const catalogCache = new Map<string, Promise<StoreProduct[]>>()

/** Same as `fetchCatalog`, memoized per (facilitator, merchant) for the tab's
 * lifetime — a merchant's catalog doesn't change fast enough to justify a
 * fresh fetch every time a receipt for that merchant is opened. A failed
 * fetch is evicted rather than cached, so a transient failure doesn't
 * permanently pin every later receipt to "no product names." */
export function fetchCatalogCached(
  facilitatorUrl: string,
  merchantId: string,
): Promise<StoreProduct[]> {
  const key = `${facilitatorUrl}::${merchantId}`
  let pending = catalogCache.get(key)
  if (!pending) {
    pending = fetchCatalog(facilitatorUrl, merchantId).catch((err: unknown) => {
      catalogCache.delete(key)
      throw err
    })
    catalogCache.set(key, pending)
  }
  return pending
}

export function safeParseCart(cartJson: string): CartMandate | null {
  try {
    return JSON.parse(cartJson) as CartMandate
  } catch {
    return null
  }
}

export type OrderSummary = {
  itemCount: number
  firstItemSku: string | null
  totalPaise: number
}

/** Derives the list-card summary from a settlement's `cart_json`. An
 * unparseable cart (should never happen — the facilitator only ever writes
 * what it itself signed off on) degrades to a zero-item summary rather than
 * throwing, so one bad row can't blank the whole Orders list. */
export function orderSummary(settlement: {
  cart_json: string
  amount_paise: number
}): OrderSummary {
  const cart = safeParseCart(settlement.cart_json)
  if (!cart) return { itemCount: 0, firstItemSku: null, totalPaise: settlement.amount_paise }
  return {
    itemCount: cart.items.length,
    firstItemSku: cart.items[0]?.sku ?? null,
    totalPaise: cart.total_paise,
  }
}

export type PaymentInfo = {
  paymentId: string | null
  orderId: string | null
  method: SettlementAttempt['method'] | null
  state: SettlementAttempt['state'] | null
}

/** The attempt a receipt should show as "the payment": the captured one if
 * there is one (at most one, per the `one_captured_attempt` DB constraint),
 * otherwise the most recent attempt so a failed/pending settlement still
 * shows what was tried. */
export function capturedPayment(attempts: SettlementAttempt[]): PaymentInfo {
  if (attempts.length === 0) return { paymentId: null, orderId: null, method: null, state: null }
  const captured = attempts.find((a) => a.state === 'captured')
  const chosen =
    captured ?? attempts.reduce((latest, a) => (a.created_at > latest.created_at ? a : latest))
  return {
    paymentId: chosen.provider_payment_id,
    orderId: chosen.provider_order_id,
    method: chosen.method,
    state: chosen.state,
  }
}

/** sku -> title, built once per catalog fetch. `productTitle` falls back to
 * the bare sku when the catalog has no matching listing (deleted product,
 * catalog re-scanned since the order was placed, etc.) — a missing title is
 * a display gap, not a reason to hide the line item. */
export function buildSkuTitleMap(products: readonly StoreProduct[]): Map<string, string> {
  return new Map(products.map((p) => [p.id, p.title]))
}

export function productTitle(skuTitleMap: Map<string, string>, sku: string): string {
  return skuTitleMap.get(sku) ?? sku
}

export type ParsedLedgerEvent = {
  seq: number
  event_type: LedgerEventType
  settlement_id: string | null
  actor: string
  payload: Record<string, unknown>
  created_at: number
  row_hash: string
}

/** Parses a raw ledger row's `payload` JSON string (see `RawLedgerEventRow` —
 * GET /settlements/:id, unlike GET /ledger, embeds it unparsed). A malformed
 * payload degrades to `{}` rather than throwing, so `describeLedgerEvent`'s
 * defensive field reads still render a plain sentence instead of taking the
 * whole receipt down. */
export function parseLedgerEvent(row: RawLedgerEventRow): ParsedLedgerEvent {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    // payload stays {} — see doc comment above
  }
  return {
    seq: row.seq,
    event_type: row.event_type as LedgerEventType,
    settlement_id: row.settlement_id,
    actor: row.actor,
    payload,
    created_at: row.created_at,
    row_hash: row.row_hash,
  }
}

/** Finds and parses the `IntentMandate` that authorized a settlement, from
 * the full GET /mandates list. Missing row or unparseable `intent_json`
 * both degrade to `null` — the receipt falls back to showing the raw
 * mandate id, same as MandatesList/PendingApprovals do for their own rows. */
export function findMandateIntent(
  mandates: readonly MandateListItem[],
  mandateId: string,
): IntentMandate | null {
  const row = mandates.find((m) => m.mandate_id === mandateId)
  if (!row) return null
  try {
    return JSON.parse(row.intent_json) as IntentMandate
  } catch {
    return null
  }
}
