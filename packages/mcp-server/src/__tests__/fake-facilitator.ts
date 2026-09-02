/** A hand-rolled fetch stub standing in for the real facilitator HTTP surface —
 * routes on method + pathname exactly like the real routes this server calls
 * (GET /stores, GET /catalog/:id, GET /mandates, POST /settlements, GET
 * /settlements/:id), so a test only needs to describe the data those routes
 * would return, not reimplement HTTP plumbing. Any request outside that route
 * set throws — a test hitting an unhandled route is a bug in the test's setup,
 * not a case to silently no-op. */

import type { CartMandate, IntentMandate } from '@hundi/core'
import type { Product } from '../../../../agents/scripted-brain/src/agent-tools.js'

export type FakeMandateRow = {
  mandate_id: string
  intent_json: string
  revoked_at: number | null
  created_at: number
}

export type FakeSettlementEnvelope = {
  ok: true
  settlement: {
    id: string
    mandate_id: string
    state: string
    amount_paise: number
    merchant_id: string
    cart_json: string
    reject_reason: string | null
    created_at: number
  }
  attempts: {
    state: string
    provider_payment_id: string | null
    receipt: string
    created_at: number
  }[]
  ledger: { event_type: string; actor: string; created_at: number }[]
}

export type CreateSettlementCall = {
  intent: IntentMandate
  cart: CartMandate
  idempotencyKey: string | null
}

export type ProposeMandateCall = {
  merchant_id: string
  goal: string
  ceiling_paise: number
  approval_threshold_paise: number
  agent_pubkey_hex: string
  per_merchant_ceiling_paise?: Record<string, number>
  cumulative_approval_threshold_paise?: number
  allowed_skus?: string[]
}

export type FakeFacilitatorState = {
  stores?: { merchant_id: string; name: string; product_count: number; source_url?: string }[]
  catalogs?: Record<string, Product[]>
  mandates?: FakeMandateRow[]
  settlementsById?: Record<string, FakeSettlementEnvelope>
  /** Rows returned by the GET /settlements list endpoint (list_orders). */
  settlementsList?: {
    id: string
    mandate_id: string
    state: string
    amount_paise: number
    merchant_id: string
    cart_json: string
    created_at: number
    reject_reason: string | null
  }[]
  /** Called on every POST /settlements; return `undefined` to fall back to a default
   * `{ ok: true, settlement_id: 'settlement-1', state: 'approved' }` 202. */
  onCreateSettlement?: (call: CreateSettlementCall) => { status: number; body: unknown }
  /** Every intercepted POST /settlements call, in order — assert against this. */
  createSettlementCalls: CreateSettlementCall[]
  /** Called on every POST /mandates/propose; return `undefined` to fall back to a default
   * `{ ok: true, proposal_id: 'proposal-1', approve_url: 'http://localhost:5173/?propose=proposal-1' }` 201. */
  onProposeMandate?: (call: ProposeMandateCall) => { status: number; body: unknown }
  /** Every intercepted POST /mandates/propose call, in order — assert against this. */
  proposeMandateCalls: ProposeMandateCall[]
  /** Response for POST /stores/onboard; defaults to a 201 success. */
  onboardResponse?: { status: number; body: unknown }
  /** Every intercepted POST /stores/onboard call (url + onboard token header). */
  onboardCalls: { url: string; onboardToken: string | null }[]
  /** Results returned by GET /catalog/search — the test pre-computes whatever ranked,
   * cross-merchant list it wants the fake to hand back; this stub does no ranking of
   * its own (the real ranking is the facilitator's, tested at that layer). */
  catalogSearchResults?: Product[]
  /** Every intercepted GET /catalog/search call's query params, in order — assert
   * against this to check the tool forwarded query/max_price/merchant_id/etc. correctly. */
  catalogSearchCalls: Record<string, string>[]
  /** Results returned by GET /catalog/:merchant_id/upsell — the test pre-computes
   * whatever ranked list it wants the fake to hand back; this stub does no ranking
   * of its own (the real ranking is the facilitator's, tested at that layer). */
  upsellResults?: Product[]
  /** Every intercepted GET /catalog/:merchant_id/upsell call's merchant_id + query
   * params, in order — assert against this to check the tool forwarded sku/limit
   * correctly. */
  upsellCalls: { merchantId: string; params: Record<string, string> }[]
}

export function makeFakeFacilitatorState(
  overrides: Omit<
    FakeFacilitatorState,
    | 'createSettlementCalls'
    | 'proposeMandateCalls'
    | 'onboardCalls'
    | 'catalogSearchCalls'
    | 'upsellCalls'
  > = {},
): FakeFacilitatorState {
  return {
    ...overrides,
    createSettlementCalls: [],
    proposeMandateCalls: [],
    onboardCalls: [],
    catalogSearchCalls: [],
    upsellCalls: [],
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function fakeFacilitatorFetch(state: FakeFacilitatorState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const { pathname } = new URL(url)
    const method = init?.method ?? 'GET'

    if (method === 'GET' && pathname === '/stores') {
      return jsonResponse({ ok: true, stores: state.stores ?? [] })
    }

    // Must be checked before the /catalog/:merchant_id startsWith branch below —
    // same literal-before-param precedence the real facilitator's app.ts enforces
    // by registration order (see catalog-search.ts).
    if (method === 'GET' && pathname === '/catalog/search') {
      const params: Record<string, string> = {}
      for (const [key, value] of new URL(url).searchParams) params[key] = value
      state.catalogSearchCalls.push(params)
      const results = state.catalogSearchResults ?? []
      return jsonResponse({ ok: true, results, count: results.length })
    }

    // Must be checked before the /catalog/:merchant_id startsWith branch below —
    // same literal-before-param precedence /catalog/search needs (see above).
    const upsellMatch = pathname.match(/^\/catalog\/([^/]+)\/upsell$/)
    if (method === 'GET' && upsellMatch) {
      const merchantId = decodeURIComponent(upsellMatch[1] as string)
      const params: Record<string, string> = {}
      for (const [key, value] of new URL(url).searchParams) params[key] = value
      state.upsellCalls.push({ merchantId, params })
      const results = state.upsellResults ?? []
      return jsonResponse({ ok: true, sku: params.sku, results, count: results.length })
    }

    if (method === 'GET' && pathname.startsWith('/catalog/')) {
      const merchantId = decodeURIComponent(pathname.slice('/catalog/'.length))
      const products = state.catalogs?.[merchantId]
      if (!products) return jsonResponse({ ok: false, error: 'CATALOG_NOT_FOUND' }, 404)
      return jsonResponse(products)
    }

    if (method === 'GET' && pathname === '/mandates') {
      return jsonResponse({ ok: true, mandates: state.mandates ?? [] })
    }

    if (method === 'GET' && pathname === '/settlements') {
      return jsonResponse({ ok: true, settlements: state.settlementsList ?? [] })
    }

    if (method === 'POST' && pathname === '/settlements') {
      const parsed = JSON.parse(String(init?.body)) as { intent: IntentMandate; cart: CartMandate }
      const headers = init?.headers as Record<string, string> | undefined
      const call: CreateSettlementCall = {
        intent: parsed.intent,
        cart: parsed.cart,
        idempotencyKey: headers?.['Idempotency-Key'] ?? null,
      }
      state.createSettlementCalls.push(call)
      const outcome = state.onCreateSettlement?.(call) ?? {
        status: 202,
        body: { ok: true, settlement_id: 'settlement-1', state: 'approved' },
      }
      return jsonResponse(outcome.body, outcome.status)
    }

    if (method === 'POST' && pathname === '/stores/onboard') {
      const parsed = JSON.parse(String(init?.body)) as { url: string }
      const headers = init?.headers as Record<string, string> | undefined
      state.onboardCalls.push({
        url: parsed.url,
        onboardToken: headers?.['x-hundi-onboard-token'] ?? null,
      })
      const outcome = state.onboardResponse ?? {
        status: 201,
        body: {
          ok: true,
          merchant_id: 'example-com',
          name: 'example.com',
          product_count: 42,
          sample: ['Widget A', 'Widget B'],
          warnings: [],
        },
      }
      return jsonResponse(outcome.body, outcome.status)
    }

    if (method === 'POST' && pathname === '/mandates/propose') {
      const call = JSON.parse(String(init?.body)) as ProposeMandateCall
      state.proposeMandateCalls.push(call)
      const outcome = state.onProposeMandate?.(call) ?? {
        status: 201,
        body: {
          ok: true,
          proposal_id: 'proposal-1',
          approve_url: 'http://localhost:5173/?propose=proposal-1',
        },
      }
      return jsonResponse(outcome.body, outcome.status)
    }

    if (method === 'GET' && pathname.startsWith('/settlements/')) {
      const id = decodeURIComponent(pathname.slice('/settlements/'.length))
      const entry = state.settlementsById?.[id]
      if (!entry) return jsonResponse({ ok: false, error: 'SETTLEMENT_NOT_FOUND' }, 404)
      return jsonResponse(entry)
    }

    throw new Error(`fakeFacilitatorFetch: unhandled request ${method} ${url}`)
  }) as typeof fetch
}
