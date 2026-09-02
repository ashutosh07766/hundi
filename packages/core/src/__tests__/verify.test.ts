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

  it('accepts the two-key model: intent signed by a distinct human key, cart signed by the agent key', () => {
    // The real separation-of-parties path — impossible before the fix, when the
    // registered credential was forced to equal the agent key. The human key is
    // the registered credential and verifies the intent; the agent key (attested
    // by that human-signed intent) verifies the cart. They are different keys.
    const human = makeEd25519Keypair(new Uint8Array(32).fill(11))
    const agent = makeEd25519Keypair(new Uint8Array(32).fill(22))
    expect(human.publicKeyHex).not.toBe(agent.publicKeyHex)
    const { intent } = makeIntent({ agent, human })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(human) }))
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

  it('SIG_INVALID_CART: cart signed by a key that is not intent.agent_pubkey_hex', () => {
    // Human signs the intent; the intent attests `agent`'s key as the cart signer.
    // A cart signed by some *other* key must be rejected — the cart is verified
    // against the attested agent key, never the registered (human) credential.
    const human = makeEd25519Keypair(new Uint8Array(32).fill(11))
    const agent = makeEd25519Keypair(new Uint8Array(32).fill(22))
    const impostor = makeEd25519Keypair(new Uint8Array(32).fill(33))
    const { intent } = makeIntent({ agent, human })
    const cart = makeCart({ agent: impostor, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(human) }))
    expect(result).toMatchObject({ ok: false, reason: 'SIG_INVALID_CART' })
  })

  it('SIG_INVALID_CART: cart sig corrupted', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const tampered = { ...cart, agent_sig_hex: '00'.repeat(64) }
    const result = verifyChain(intent, tampered, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SIG_INVALID_CART' })
  })

  it('SIG_INVALID_CART: variant_id swapped after signing', () => {
    // The agent signed a cart for one specific variant; a cart claiming the same
    // sku/qty/price but a *different* variant_id must fail signature verification
    // — this is the whole point of covering variant_id in cartSigningBytes.
    const { intent, agent } = makeIntent()
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 100_000, variant_id: 'variant-11' }],
    })
    const swapped = {
      ...cart,
      items: [{ ...cart.items[0]!, variant_id: 'variant-12' }],
    }
    const result = verifyChain(intent, swapped, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SIG_INVALID_CART' })
  })

  it('SCHEMA_INVALID: empty-string variant_id', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 100_000, variant_id: '' }],
    })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' })
  })

  it('accepts a cart with a well-formed variant_id + variant_label', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({
      agent,
      intent,
      items: [
        {
          sku: 'sku-1',
          qty: 1,
          unit_price_paise: 100_000,
          variant_id: 'variant-11',
          variant_label: '11 / Black',
        },
      ],
    })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result.ok).toBe(true)
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

  it('cumulative wallet: prior spend that pushes cart over the ceiling is AMOUNT_EXCEEDS_CEILING', () => {
    // ceiling 500_000, default cart total 200_000, already spent 400_000 →
    // 600_000 > 500_000. The single cart fits the ceiling; the cumulative total doesn't.
    const { intent, agent } = makeIntent({ overrides: { ceiling_paise: 500_000 } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), spentPaise: 400_000 }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'AMOUNT_EXCEEDS_CEILING' })
  })

  it('cumulative wallet: a mandate with prior spend still passes while cumulative total is within the ceiling', () => {
    // 200_000 already spent + 200_000 this cart = 400_000 ≤ 500_000 → reusable.
    const { intent, agent } = makeIntent({ overrides: { ceiling_paise: 500_000 } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), spentPaise: 200_000 }),
    )
    expect(result.ok).toBe(true)
  })

  it('MERCHANT_NOT_IN_SCOPE: cart merchant not listed on the intent', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent, overrides: { merchant_id: 'someone-else' } })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'MERCHANT_NOT_IN_SCOPE' })
  })

  it('MERCHANT_LIMIT_EXCEEDED: cart + prior merchant spend above the per-merchant sub-ceiling', () => {
    // Global ceiling 500_000 fits the 200_000 cart, but the merchant-1 sub-ceiling
    // is 150_000, so the cart alone already blows it.
    const { intent, agent } = makeIntent({
      overrides: { ceiling_paise: 500_000, per_merchant_ceiling_paise: { 'merchant-1': 150_000 } },
    })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'MERCHANT_LIMIT_EXCEEDED' })
  })

  it('per-merchant sub-ceiling: passes while merchant spend stays within the limit', () => {
    const { intent, agent } = makeIntent({
      overrides: { ceiling_paise: 500_000, per_merchant_ceiling_paise: { 'merchant-1': 300_000 } },
    })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), merchantSpentPaise: 50_000 }),
    )
    expect(result.ok).toBe(true)
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

  it('reports MANDATE_REVOKED, not AMOUNT_EXCEEDS_CEILING, when a revoked mandate is also over budget', () => {
    // Regression guard for the check-order fix: mandate liveness is checked
    // before the cumulative budget, so a dead mandate says it's dead rather than
    // reporting a budget error. Under the wallet, prior spend can trip the ceiling
    // check for an otherwise-fine cart, which is what would surface the wrong
    // code if the order were swapped back.
    const { intent, agent } = makeIntent({ overrides: { ceiling_paise: 500_000 } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), revoked: true, spentPaise: 500_000 }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'MANDATE_REVOKED' })
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

describe('verifyChain — goal_keywords (intent-binding)', () => {
  it('accepts when goal_keywords is absent, regardless of itemGoalTexts', () => {
    const { intent, agent } = makeIntent()
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result.ok).toBe(true)
  })

  it('accepts a cart item whose resolved text matches a goal keyword', () => {
    const { intent, agent } = makeIntent({
      overrides: { goal_keywords: ['running shoe', 'sneaker'] },
    })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({
        credential: credentialFor(agent),
        itemGoalTexts: { 'sku-1': 'velocity air running shoe, size 11' },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('GOAL_MISMATCH: cart item text matches none of the goal_keywords', () => {
    const { intent, agent } = makeIntent({
      overrides: { goal_keywords: ['running shoe', 'sneaker'] },
    })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({
        credential: credentialFor(agent),
        itemGoalTexts: { 'sku-1': 'countertop blender 600w' },
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'GOAL_MISMATCH' })
  })

  it('GOAL_MISMATCH: fails closed when the sku has no resolved goal text at all', () => {
    const { intent, agent } = makeIntent({ overrides: { goal_keywords: ['running shoe'] } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), itemGoalTexts: {} }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'GOAL_MISMATCH' })
  })

  it('matching is case-insensitive', () => {
    const { intent, agent } = makeIntent({ overrides: { goal_keywords: ['Running Shoe'] } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({
        credential: credentialFor(agent),
        itemGoalTexts: { 'sku-1': 'velocity running shoe' },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('SCHEMA_INVALID: empty goal_keywords array', () => {
    const { intent, agent } = makeIntent({ overrides: { goal_keywords: [] } })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(intent, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SCHEMA_INVALID' })
  })

  it('signed goal_keywords is tamper-evident: loosening the list after signing fails SIG_INVALID_INTENT', () => {
    const { intent, agent } = makeIntent({ overrides: { goal_keywords: ['running shoe'] } })
    // Swap in a keyword the human never signed off on — the signature must reject it.
    const tampered = { ...intent, goal_keywords: ['blender'] }
    const cart = makeCart({ agent, intent: tampered })
    const result = verifyChain(tampered, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SIG_INVALID_INTENT' })
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

  it('cumulative approval line: a sub-per-cart-threshold cart still needs approval once total spend crosses it', () => {
    // Per-cart threshold 300_000 would NOT flag this 200_000 cart, but the
    // cumulative line is 250_000 and prior spend is 100_000, so 300_000 crosses
    // it — the cart-splitting gap is closed.
    const { intent, agent } = makeIntent({
      overrides: {
        ceiling_paise: 1_000_000,
        approval_threshold_paise: 300_000,
        cumulative_approval_threshold_paise: 250_000,
      },
    })
    const cart = makeCart({ agent, intent })
    const result = verifyChain(
      intent,
      cart,
      baseCtx({ credential: credentialFor(agent), spentPaise: 100_000 }),
    )
    expect(result).toMatchObject({ ok: true, needsApproval: true })
  })

  it('signed policy is tamper-evident: editing per_merchant_ceiling_paise after signing fails SIG_INVALID_INTENT', () => {
    const { intent, agent } = makeIntent({
      overrides: { per_merchant_ceiling_paise: { 'merchant-1': 150_000 } },
    })
    // Loosen the merchant limit after the human signed — the signature must reject it.
    const tampered = {
      ...intent,
      per_merchant_ceiling_paise: { 'merchant-1': 900_000 },
    }
    const cart = makeCart({ agent, intent: tampered })
    const result = verifyChain(tampered, cart, baseCtx({ credential: credentialFor(agent) }))
    expect(result).toMatchObject({ ok: false, reason: 'SIG_INVALID_INTENT' })
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
