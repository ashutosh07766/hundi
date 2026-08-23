import { describe, expect, it } from 'vitest'
import type { VerifyCtx } from '../verify.js'
import { verifyChain } from '../verify.js'
import { credentialFor, makeCart, makeEd25519Keypair, makeIntent } from './fixtures.js'

const NOW = 1_500_000_000

// `credential` is always overridden by callers (it must match the specific intent/agent pair
// under test), so the default here is intentionally omitted rather than backed by a keypair.
function baseCtx(overrides: Partial<VerifyCtx> = {}): VerifyCtx {
  return {
    now: NOW,
    revoked: false,
    allowance: 'available',
    duplicateCart: false,
    ...overrides,
  }
}

describe('verifyChain — happy path', () => {
  it('accepts a valid intent + cart under the approval threshold', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.needsApproval).toBe(false)
      expect(result.mandateCartHashHex).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('verifyChain — one row per RejectionCode', () => {
  it('SCHEMA_INVALID: empty merchants array', () => {
    const { intent, agent } = makeIntent({ overrides: { merchants: [] } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' })
  })

  it('MANDATE_UNKNOWN: no credential registered', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx())
    expect(result).toMatchObject({ ok: false, reason: 'MANDATE_UNKNOWN' })
  })

  it('SIG_INVALID_INTENT: intent sig corrupted', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const tampered = {
      ...intent,
      sig: { type: 'ed25519' as const, signature_hex: '00'.repeat(64) },
    }
    const result = verifyChain(tampered, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SIG_INVALID_INTENT' })
  })

  it('HASH_LINK_MISMATCH: cart points at the wrong intent hash', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent, overrides: { intent_hash_hex: '00'.repeat(32) } })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'HASH_LINK_MISMATCH' })
  })

  it('AGENT_KEY_MISMATCH: intent signed by its real key but claims a different agent_pubkey_hex', () => {
    // The signature is genuinely valid (signed by `agent`), so SIG_INVALID_INTENT passes — the
    // mismatch is that the payload's own agent_pubkey_hex field names a different key.
    const otherAgent = makeEd25519Keypair(new Uint8Array(32).fill(42))
    const { intent, agent } = makeIntent({
      overrides: { agent_pubkey_hex: otherAgent.publicKeyHex },
    })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'AGENT_KEY_MISMATCH' })
  })

  it('SIG_INVALID_CART: cart sig corrupted', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const tampered = { ...cart, agent_sig_hex: '00'.repeat(64) }
    const result = verifyChain(intent, tampered, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SIG_INVALID_CART' })
  })

  it('LINE_ITEM_INVALID: total does not match recomputed sum', () => {
    const { intent, agent } = makeIntent()
    // total_paise override alone would fail schema (it's still a valid non-negative int), so this
    // reaches the recompute check and fails there instead.
    const cart = makeCart({ agent, intent, overrides: { total_paise: 1 } })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'LINE_ITEM_INVALID' })
  })

  it('PRICE_MISMATCH: unit price disagrees with the catalog', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), catalogPrices: { 'sku-1': 999 } }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'PRICE_MISMATCH' })
  })

  it('PRICE_MISMATCH: sku missing from the catalog', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), catalogPrices: {} }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'PRICE_MISMATCH' })
  })

  it('CURRENCY_MISMATCH: intent currency is not INR', () => {
    const { intent, agent } = makeIntent({
      overrides: { currency: 'USD' as unknown as 'INR' },
    })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'CURRENCY_MISMATCH' })
  })

  it('AMOUNT_EXCEEDS_CEILING: cart total above the ceiling', () => {
    const { intent, agent } = makeIntent({ overrides: { ceiling_paise: 100 } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'AMOUNT_EXCEEDS_CEILING' })
  })

  it('MERCHANT_NOT_IN_SCOPE: cart merchant not listed on the intent', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent, overrides: { merchant_id: 'someone-else' } })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'MERCHANT_NOT_IN_SCOPE' })
  })

  it('MANDATE_EXPIRED: now is past expiry + skew', () => {
    const { intent, agent } = makeIntent({ overrides: { expires_at: 1_000 } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), now: 1_000 + 61 }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'MANDATE_EXPIRED' })
  })

  it('MANDATE_REVOKED: ctx.revoked is true', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), revoked: true }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'MANDATE_REVOKED' })
  })

  it('ALLOWANCE_RESERVED', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), allowance: 'reserved' }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'ALLOWANCE_RESERVED' })
  })

  it('ALLOWANCE_CONSUMED', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), allowance: 'consumed' }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'ALLOWANCE_CONSUMED' })
  })

  it('DUPLICATE_CART', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), duplicateCart: true }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'DUPLICATE_CART' })
  })
})

describe('verifyChain — boundaries', () => {
  it('total == ceiling passes the ceiling check', () => {
    const { intent, agent } = makeIntent({ overrides: { ceiling_paise: 200_000 } })
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 2, unit_price_paise: 100_000 }],
    })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result.ok).toBe(true)
  })

  it('total == threshold does not need approval', () => {
    const { intent, agent } = makeIntent({ overrides: { approval_threshold_paise: 200_000 } })
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 2, unit_price_paise: 100_000 }],
    })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: true, needsApproval: false })
  })

  it('total == threshold + 1 needs approval', () => {
    const { intent, agent } = makeIntent({ overrides: { approval_threshold_paise: 200_000 } })
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 200_001 }],
    })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: true, needsApproval: true })
  })

  it('expiry at exactly now - skew passes', () => {
    const { intent, agent } = makeIntent({ overrides: { expires_at: 1_000 } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), now: 1_060 }),
    )
    expect(result.ok).toBe(true)
  })

  it('expiry one second past the skew window fails', () => {
    const { intent, agent } = makeIntent({ overrides: { expires_at: 1_000 } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), now: 1_061 }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'MANDATE_EXPIRED' })
  })
})
