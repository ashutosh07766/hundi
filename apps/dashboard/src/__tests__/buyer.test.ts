import type { IntentMandate } from '@hundi/core'
import {
  cartSigningBytes,
  intentSigningBytes,
  sha256Hex,
  verifyMandateSignature,
} from '@hundi/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreProduct } from '../lib/buyer.js'
import { buildUnsignedCart, pickProduct, runTestPurchase, signCart } from '../lib/buyer.js'
import { generateKeypair } from '../lib/signing.js'

const INTENT: IntentMandate = {
  mandateId: 'mandate-1',
  goal: 'Buy running shoes',
  ceiling_paise: 400_000,
  approval_threshold_paise: 500_000,
  currency: 'INR',
  merchants: ['demo-store-1'],
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  agent_pubkey_hex: 'aa'.repeat(32),
  sig: { type: 'ed25519', signature_hex: 'ab'.repeat(32) },
}

const CATALOG: StoreProduct[] = [
  {
    id: 'sku-001',
    title: 'Velocity Air Runner',
    price_paise: 320_000,
    availability: { status: 'in_stock' },
    merchant_id: 'demo-store-1',
  },
  {
    id: 'sku-002',
    title: 'Velocity Air Runner Pro',
    price_paise: 450_000,
    availability: { status: 'in_stock' },
    merchant_id: 'demo-store-1',
  },
  {
    id: 'sku-003',
    title: 'Velocity Cloudstep',
    price_paise: 200_000,
    availability: { status: 'out_of_stock' },
    merchant_id: 'demo-store-1',
  },
  {
    id: 'sku-004',
    title: 'Velocity Featherlite',
    price_paise: 350_000,
    availability: { status: 'in_stock' },
    merchant_id: 'demo-store-1',
  },
]

const POISONED_PRODUCT: StoreProduct = {
  id: 'sku-poison',
  title: 'Apex Motion Trail Runner',
  price_paise: 460_000,
  availability: { status: 'in_stock' },
  merchant_id: 'demo-store-1',
  injectedPayload: { merchant_id: 'attacker-store', price_paise: 320_000 },
}

describe('pickProduct', () => {
  it('picks the cheapest in-stock product at or under the ceiling', () => {
    const result = pickProduct(CATALOG, INTENT, false)
    expect(result).toEqual({
      ok: true,
      product: CATALOG[0],
      merchantId: 'demo-store-1',
      unitPricePaise: 320_000,
    })
  })

  it('excludes out-of-stock items even when cheaper', () => {
    const result = pickProduct(CATALOG, { ceiling_paise: 250_000 }, false)
    expect(result).toEqual({ ok: false, reason: 'NO_CANDIDATE' })
  })

  it('excludes items over the ceiling', () => {
    const result = pickProduct(CATALOG, { ceiling_paise: 10 }, false)
    expect(result).toEqual({ ok: false, reason: 'NO_CANDIDATE' })
  })

  it('poisoned mode selects the attacker-payload listing, ignoring ceiling/stock rules', () => {
    const result = pickProduct([...CATALOG, POISONED_PRODUCT], { ceiling_paise: 1 }, true)
    expect(result).toEqual({
      ok: true,
      product: POISONED_PRODUCT,
      merchantId: 'attacker-store',
      unitPricePaise: 320_000,
    })
  })

  it('poisoned mode with no injected listing is blocked, not a silent no-op', () => {
    const result = pickProduct(CATALOG, INTENT, true)
    expect(result).toEqual({ ok: false, reason: 'NO_POISONED_PRODUCT' })
  })
})

describe('buildUnsignedCart + signCart', () => {
  it('produces integer paise and a hash chained to the intent', () => {
    const pick = pickProduct(CATALOG, INTENT, false)
    if (!pick.ok) throw new Error('expected a pick')
    const unsigned = buildUnsignedCart(pick, INTENT)
    expect(Number.isInteger(unsigned.total_paise)).toBe(true)
    expect(unsigned.total_paise).toBe(320_000)
    expect(unsigned.items).toEqual([{ sku: 'sku-001', qty: 1, unit_price_paise: 320_000 }])
    expect(unsigned.intent_hash_hex).toBe(sha256Hex(intentSigningBytes(INTENT)))
  })

  it('signs with the agent key so core.verifyMandateSignature accepts it against agent_pubkey_hex', () => {
    const agentKeyPair = generateKeypair()
    const intent: IntentMandate = { ...INTENT, agent_pubkey_hex: agentKeyPair.publicKeyHex }
    const pick = pickProduct(CATALOG, intent, false)
    if (!pick.ok) throw new Error('expected a pick')
    const unsigned = buildUnsignedCart(pick, intent)
    const cart = signCart(unsigned, agentKeyPair)

    const verified = verifyMandateSignature(
      cartSigningBytes(unsigned),
      { type: 'ed25519', signature_hex: cart.agent_sig_hex },
      { type: 'ed25519', publicKey_hex: intent.agent_pubkey_hex },
    )
    expect(verified).toBe(true)
  })
})

describe('runTestPurchase', () => {
  const originalFetch = globalThis.fetch
  const agentKeyPair = generateKeypair()

  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetches the mandate merchant catalog from the facilitator, signs a cart with the agent key, and POSTs it with an Idempotency-Key', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/catalog/demo-store-1')) {
        return new Response(JSON.stringify(CATALOG), { status: 200 })
      }
      if (url.endsWith('/settlements')) {
        return new Response(
          JSON.stringify({ ok: true, settlement_id: 'settle-1', state: 'captured' }),
          { status: 202 },
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await runTestPurchase({
      mandateId: 'mandate-1',
      intent: { ...INTENT, agent_pubkey_hex: agentKeyPair.publicKeyHex },
      agentKeyPair,
      facilitatorUrl: 'http://127.0.0.1:8790',
      poisoned: false,
    })

    expect(result).toEqual({
      ok: true,
      state: 'captured',
      chosen: { title: 'Velocity Air Runner', price_paise: 320_000 },
      paymentId: 'settle-1',
    })

    expect(calls[0]?.url).toBe('http://127.0.0.1:8790/catalog/demo-store-1')
    const postCall = calls.find((c) => c.url === 'http://127.0.0.1:8790/settlements')
    expect(postCall).toBeDefined()
    expect(postCall?.init?.method).toBe('POST')
    const headers = postCall?.init?.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    const body = JSON.parse(postCall?.init?.body as string) as {
      intent: IntentMandate
      cart: unknown
    }
    expect(body.intent.mandateId).toBe('mandate-1')
    expect(body.cart).toMatchObject({
      merchant_id: 'demo-store-1',
      items: [{ sku: 'sku-001', qty: 1, unit_price_paise: 320_000 }],
      total_paise: 320_000,
    })
  })

  it('poisoned mode builds a cart pointing at the attacker merchant, and surfaces a facilitator block as ok:false', async () => {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/catalog/demo-store-1')) {
        expect(url).toContain('poisoned=1')
        return new Response(JSON.stringify([...CATALOG, POISONED_PRODUCT]), { status: 200 })
      }
      if (url.endsWith('/settlements')) {
        const body = JSON.parse((init?.body as string) ?? '{}')
        expect(body.cart.merchant_id).toBe('attacker-store')
        return new Response(
          JSON.stringify({
            ok: true,
            settlement_id: 'settle-2',
            state: 'rejected',
            reason: 'MERCHANT_NOT_IN_SCOPE',
          }),
          { status: 202 },
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await runTestPurchase({
      mandateId: 'mandate-1',
      intent: { ...INTENT, agent_pubkey_hex: agentKeyPair.publicKeyHex },
      agentKeyPair,
      facilitatorUrl: 'http://127.0.0.1:8790',
      poisoned: true,
    })

    expect(result.ok).toBe(false)
    expect(result.state).toBe('rejected')
    expect(result.reason).toBe('MERCHANT_NOT_IN_SCOPE')
  })

  it('reports a no-candidate outcome without ever calling the facilitator settlement endpoint', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/catalog/demo-store-1')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await runTestPurchase({
      mandateId: 'mandate-1',
      intent: INTENT,
      agentKeyPair,
      facilitatorUrl: 'http://127.0.0.1:8790',
      poisoned: false,
    })

    expect(result).toEqual({ ok: false, state: 'blocked', reason: 'NO_CANDIDATE' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('reports a clean block when the mandate has no merchant in scope, without calling fetch', async () => {
    const mockFetch = vi.fn()
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await runTestPurchase({
      mandateId: 'mandate-1',
      intent: { ...INTENT, merchants: [] },
      agentKeyPair,
      facilitatorUrl: 'http://127.0.0.1:8790',
      poisoned: false,
    })

    expect(result).toEqual({ ok: false, state: 'blocked', reason: 'NO_MERCHANT_IN_SCOPE' })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
