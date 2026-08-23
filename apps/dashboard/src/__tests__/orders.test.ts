import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../lib/api.js'
import {
  buildSkuTitleMap,
  capturedPayment,
  fetchCatalogCached,
  fetchSettlement,
  fetchSettlements,
  findMandateIntent,
  orderSummary,
  parseLedgerEvent,
  productTitle,
  type RawLedgerEventRow,
  type SettlementAttempt,
} from '../lib/orders.js'

const FACILITATOR_URL = 'http://127.0.0.1:8790'

function cartJson(items: { sku: string; qty: number; unit_price_paise: number }[], total: number) {
  return JSON.stringify({
    cartId: 'cart-1',
    merchant_id: 'demo-store-1',
    items,
    total_paise: total,
    intent_hash_hex: 'aa',
    agent_sig_hex: 'bb',
  })
}

function attempt(overrides: Partial<SettlementAttempt>): SettlementAttempt {
  return {
    id: 'att-1',
    settlement_id: 's-1',
    method: 'checkout_driver',
    state: 'initiated',
    receipt: 'receipt-1',
    provider_order_id: null,
    provider_payment_id: null,
    provider_link_id: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  }
}

describe('orderSummary', () => {
  it('parses cart_json into item count, first sku, and total', () => {
    const summary = orderSummary({
      cart_json: cartJson(
        [
          { sku: 'sku-a', qty: 2, unit_price_paise: 500 },
          { sku: 'sku-b', qty: 1, unit_price_paise: 300 },
        ],
        1300,
      ),
      amount_paise: 1300,
    })
    expect(summary).toEqual({ itemCount: 2, firstItemSku: 'sku-a', totalPaise: 1300 })
  })

  it('falls back to a zero-item summary on unparseable cart_json', () => {
    const summary = orderSummary({ cart_json: 'not json', amount_paise: 999 })
    expect(summary).toEqual({ itemCount: 0, firstItemSku: null, totalPaise: 999 })
  })
})

describe('capturedPayment', () => {
  it('picks the captured attempt over other attempts', () => {
    const attempts = [
      attempt({ id: 'a1', state: 'failed', created_at: 2000 }),
      attempt({
        id: 'a2',
        state: 'captured',
        created_at: 1000,
        provider_payment_id: 'pay_123',
        provider_order_id: 'order_123',
      }),
    ]
    expect(capturedPayment(attempts)).toEqual({
      paymentId: 'pay_123',
      orderId: 'order_123',
      method: 'checkout_driver',
      state: 'captured',
    })
  })

  it('falls back to the most recent attempt when none is captured', () => {
    const attempts = [
      attempt({ id: 'a1', state: 'failed', created_at: 1000, provider_payment_id: 'pay_old' }),
      attempt({ id: 'a2', state: 'failed', created_at: 3000, provider_payment_id: 'pay_new' }),
    ]
    expect(capturedPayment(attempts).paymentId).toBe('pay_new')
  })

  it('returns nulls for an empty attempts list', () => {
    expect(capturedPayment([])).toEqual({
      paymentId: null,
      orderId: null,
      method: null,
      state: null,
    })
  })
})

describe('buildSkuTitleMap / productTitle', () => {
  const products = [
    {
      id: 'sku-a',
      title: 'Frido Foot Alignment Socks',
      price_paise: 999,
      availability: { status: 'in_stock' as const },
      merchant_id: 'demo-store-1',
    },
  ]

  it('resolves a known sku to its title', () => {
    const map = buildSkuTitleMap(products)
    expect(productTitle(map, 'sku-a')).toBe('Frido Foot Alignment Socks')
  })

  it('falls back to the sku when not found in the catalog', () => {
    const map = buildSkuTitleMap(products)
    expect(productTitle(map, 'sku-unknown')).toBe('sku-unknown')
  })
})

describe('parseLedgerEvent', () => {
  const raw: RawLedgerEventRow = {
    seq: 5,
    event_type: 'payment_captured',
    settlement_id: 's-1',
    actor: 'facilitator',
    payload: JSON.stringify({ provider_payment_id: 'pay_123' }),
    prev_hash: 'prev',
    row_hash: 'row',
    created_at: 1234,
  }

  it('parses the payload JSON', () => {
    const ev = parseLedgerEvent(raw)
    expect(ev.event_type).toBe('payment_captured')
    expect(ev.payload).toEqual({ provider_payment_id: 'pay_123' })
  })

  it('degrades to an empty payload on malformed JSON', () => {
    const ev = parseLedgerEvent({ ...raw, payload: 'not json' })
    expect(ev.payload).toEqual({})
  })
})

describe('findMandateIntent', () => {
  const intent = {
    mandateId: 'm-1',
    goal: 'buy socks',
    ceiling_paise: 100000,
    approval_threshold_paise: 50000,
    currency: 'INR' as const,
    merchants: ['demo-store-1'],
    expires_at: 9999999999,
    agent_pubkey_hex: 'ab',
    sig: { type: 'ed25519' as const, signature_hex: 'cd' },
  }
  const mandates = [
    { mandate_id: 'm-1', intent_json: JSON.stringify(intent), revoked_at: null, created_at: 1 },
  ]

  it('finds and parses the matching mandate', () => {
    expect(findMandateIntent(mandates, 'm-1')).toEqual(intent)
  })

  it('returns null when no mandate matches', () => {
    expect(findMandateIntent(mandates, 'missing')).toBeNull()
  })

  it('returns null on unparseable intent_json', () => {
    const broken = [{ mandate_id: 'm-2', intent_json: 'not json', revoked_at: null, created_at: 1 }]
    expect(findMandateIntent(broken, 'm-2')).toBeNull()
  })
})

describe('fetchSettlements', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = undefined as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('GETs /settlements and returns the list', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      return new Response(
        JSON.stringify({ ok: true, settlements: [{ id: 's-1', merchant_id: 'demo-store-1' }] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await fetchSettlements(FACILITATOR_URL)
    expect(calls[0]).toBe(`${FACILITATOR_URL}/settlements`)
    expect(result).toEqual([{ id: 's-1', merchant_id: 'demo-store-1' }])
  })

  it('throws ApiError when the server responds ok:false', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' }), {
        status: 500,
      })) as unknown as typeof fetch

    await expect(fetchSettlements(FACILITATOR_URL)).rejects.toThrow(ApiError)
  })
})

describe('fetchSettlement', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = undefined as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('GETs /settlements/:id and returns the full detail envelope', async () => {
    const calls: string[] = []
    const body = {
      ok: true,
      settlement: { id: 's-1', state: 'captured' },
      attempts: [],
      approval: null,
      ledger: [],
    }
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchSettlement(FACILITATOR_URL, 's-1')
    expect(calls[0]).toBe(`${FACILITATOR_URL}/settlements/s-1`)
    expect(result).toEqual({
      settlement: { id: 's-1', state: 'captured' },
      attempts: [],
      approval: null,
      ledger: [],
    })
  })

  it('throws ApiError on 404', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'SETTLEMENT_NOT_FOUND' }), {
        status: 404,
      })) as unknown as typeof fetch

    await expect(fetchSettlement(FACILITATOR_URL, 'nope')).rejects.toThrow(ApiError)
  })
})

describe('fetchCatalogCached', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = undefined as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetches /catalog/:merchant_id and reuses the result on a second call', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify([{ id: 'sku-a', title: 'Socks' }]), { status: 200 })
    }) as unknown as typeof fetch

    const merchantId = 'cache-test-merchant'
    const first = await fetchCatalogCached(FACILITATOR_URL, merchantId)
    const second = await fetchCatalogCached(FACILITATOR_URL, merchantId)

    expect(calls).toEqual([`${FACILITATOR_URL}/catalog/${merchantId}`])
    expect(first).toBe(second)
  })
})
