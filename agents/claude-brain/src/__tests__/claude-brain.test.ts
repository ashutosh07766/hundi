import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runPurchase } from '../../../scripted-brain/src/scripted-brain.js'
import { runClaudePurchase } from '../claude-brain.js'
import {
  FakeBuyerTools,
  fakeAnthropic,
  makeMandate,
  makeProduct,
  pickResponse,
} from './fixtures.js'

const GOAL = { query: 'running shoes', ceiling_paise: 500_000, threshold_paise: 400_000 }

describe('runClaudePurchase — happy path', () => {
  it('builds a cart for whichever sku Claude picks and pays through the tools', async () => {
    const cheap = makeProduct({ id: 'sku-cheap', price_paise: 100_000 })
    const pricier = makeProduct({ id: 'sku-pricier', price_paise: 300_000 })
    const tools = new FakeBuyerTools([cheap, pricier], { settlement_id: 's-1', state: 'captured' })

    const outcome = await runClaudePurchase({ goal: GOAL, mandate: makeMandate() }, tools, {
      anthropic: fakeAnthropic(pickResponse('sku-pricier', 'better cushioning for long runs')),
    })

    // Claude's reasoned pick — not the cheapest — proves the brain actually
    // used the model's choice rather than silently reverting to the scripted rule.
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') throw new Error('unreachable')
    expect(outcome.product.id).toBe('sku-pricier')

    expect(tools.proposeCartCalls).toHaveLength(1)
    expect(tools.proposeCartCalls[0]?.[0]?.product.id).toBe('sku-pricier')
    expect(tools.requestPaymentCalls).toHaveLength(1)
    expect(tools.requestPaymentCalls[0]?.cart.items[0]?.sku).toBe('sku-pricier')
  })

  it('records the guardrail-override rationale on a pending_approval settlement', async () => {
    const only = makeProduct({ id: 'sku-only', price_paise: 450_000 })
    const tools = new FakeBuyerTools([only], { settlement_id: 's-2', state: 'pending_approval' })

    const outcome = await runClaudePurchase({ goal: GOAL, mandate: makeMandate() }, tools, {
      anthropic: fakeAnthropic(pickResponse('sku-only')),
    })

    expect(outcome.status).toBe('pending_approval')
    expect(tools.recordDecisionCalls).toHaveLength(1)
    expect(tools.recordDecisionCalls[0]?.payload.sku).toBe('sku-only')
  })
})

describe('runClaudePurchase — guardrail fallback', () => {
  it('falls back to the cheapest in-stock match when Claude picks a sku outside the candidate list', async () => {
    const cheap = makeProduct({ id: 'sku-real-cheap', price_paise: 150_000 })
    const pricier = makeProduct({ id: 'sku-real-pricier', price_paise: 250_000 })
    const tools = new FakeBuyerTools([cheap, pricier], { settlement_id: 's-3', state: 'captured' })
    const overrides: unknown[] = []

    const outcome = await runClaudePurchase({ goal: GOAL, mandate: makeMandate() }, tools, {
      anthropic: fakeAnthropic(pickResponse('sku-does-not-exist', 'hallucinated pick')),
      log: (step, data) => {
        if (step === 'guardrail_override') overrides.push(data)
      },
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') throw new Error('unreachable')
    expect(outcome.product.id).toBe('sku-real-cheap')
    expect(overrides).toEqual([
      { reason: 'SKU_NOT_IN_CANDIDATES', claude_chosen_sku: 'sku-does-not-exist' },
    ])
  })

  it('falls back to the cheapest in-stock match when Claude picks a sku over the goal ceiling', async () => {
    const affordable = makeProduct({ id: 'sku-affordable', price_paise: 200_000 })
    const overCeiling = makeProduct({ id: 'sku-over-ceiling', price_paise: 900_000 })
    const tools = new FakeBuyerTools([affordable, overCeiling], {
      settlement_id: 's-4',
      state: 'captured',
    })
    const overrides: unknown[] = []

    const outcome = await runClaudePurchase({ goal: GOAL, mandate: makeMandate() }, tools, {
      anthropic: fakeAnthropic(pickResponse('sku-over-ceiling', 'premium pick')),
      log: (step, data) => {
        if (step === 'guardrail_override') overrides.push(data)
      },
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') throw new Error('unreachable')
    expect(outcome.product.id).toBe('sku-affordable')
    expect(overrides).toEqual([{ reason: 'OVER_CEILING', claude_chosen_sku: 'sku-over-ceiling' }])
  })

  it('falls back to the cheapest in-stock match when Claude picks an out-of-stock sku', async () => {
    const inStock = makeProduct({ id: 'sku-in-stock', price_paise: 220_000 })
    const outOfStock = makeProduct({
      id: 'sku-out-of-stock',
      price_paise: 180_000,
      availability: { status: 'out_of_stock' },
    })
    const tools = new FakeBuyerTools([inStock, outOfStock], {
      settlement_id: 's-5',
      state: 'captured',
    })
    const overrides: unknown[] = []

    const outcome = await runClaudePurchase({ goal: GOAL, mandate: makeMandate() }, tools, {
      anthropic: fakeAnthropic(pickResponse('sku-out-of-stock', 'cheapest looking option')),
      log: (step, data) => {
        if (step === 'guardrail_override') overrides.push(data)
      },
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') throw new Error('unreachable')
    expect(outcome.product.id).toBe('sku-in-stock')
    expect(overrides).toEqual([{ reason: 'OUT_OF_STOCK', claude_chosen_sku: 'sku-out-of-stock' }])
  })

  it('falls back when Claude returns unparseable text', async () => {
    const only = makeProduct({ id: 'sku-solo', price_paise: 150_000 })
    const tools = new FakeBuyerTools([only], { settlement_id: 's-6', state: 'captured' })

    const outcome = await runClaudePurchase({ goal: GOAL, mandate: makeMandate() }, tools, {
      anthropic: fakeAnthropic('not json at all'),
      log: () => {},
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') throw new Error('unreachable')
    expect(outcome.product.id).toBe('sku-solo')
  })

  it('blocks with NO_CANDIDATE when nothing is affordable and in stock, matching the scripted brain', async () => {
    const onlyOutOfStock = makeProduct({
      id: 'sku-unavailable',
      price_paise: 100_000,
      availability: { status: 'out_of_stock' },
    })
    const tools = new FakeBuyerTools([onlyOutOfStock], { settlement_id: 's-7', state: 'captured' })

    const outcome = await runClaudePurchase({ goal: GOAL, mandate: makeMandate() }, tools, {
      anthropic: fakeAnthropic(pickResponse('sku-unavailable')),
      log: () => {},
    })

    expect(outcome).toEqual({ status: 'blocked', reason: 'NO_CANDIDATE' })
    expect(tools.requestPaymentCalls).toHaveLength(0)
  })
})

describe('runClaudePurchase — parity with the scripted brain', () => {
  it('returns the same PurchaseOutcome shape runPurchase does', async () => {
    const product = makeProduct({ id: 'sku-parity', price_paise: 120_000 })

    const scriptedTools = new FakeBuyerTools([product], { settlement_id: 's-8', state: 'captured' })
    const scriptedOutcome = await runPurchase(
      {
        goal: { query: 'shoe', maxItems: 1, ceiling_paise: 500_000, threshold_paise: 400_000 },
        mandate: makeMandate(),
      },
      scriptedTools,
      () => {},
    )

    const claudeTools = new FakeBuyerTools([product], { settlement_id: 's-9', state: 'captured' })
    const claudeOutcome = await runClaudePurchase(
      { goal: GOAL, mandate: makeMandate() },
      claudeTools,
      { anthropic: fakeAnthropic(pickResponse('sku-parity')), log: () => {} },
    )

    expect(scriptedOutcome.status).toBe('completed')
    expect(claudeOutcome.status).toBe('completed')
    expect(Object.keys(scriptedOutcome).sort()).toEqual(Object.keys(claudeOutcome).sort())
    if (scriptedOutcome.status === 'completed' && claudeOutcome.status === 'completed') {
      expect(Object.keys(scriptedOutcome.product).sort()).toEqual(
        Object.keys(claudeOutcome.product).sort(),
      )
      expect(Object.keys(scriptedOutcome.settlement).sort()).toEqual(
        Object.keys(claudeOutcome.settlement).sort(),
      )
    }
  })
})

describe('claude-brain — trust boundary unchanged', () => {
  const srcDir = fileURLToPath(new URL('..', import.meta.url))

  it('never references a payment provider anywhere in this package', () => {
    for (const file of ['claude-brain.ts', 'index.ts']) {
      const source = readFileSync(`${srcDir}${file}`, 'utf8')
      expect(source, `${file} must not reference a payment provider`).not.toMatch(/razorpay/i)
    }
  })

  it('does not import a Razorpay client module', () => {
    for (const file of ['claude-brain.ts', 'index.ts']) {
      const source = readFileSync(`${srcDir}${file}`, 'utf8')
      expect(source).not.toMatch(/razorpay-client/i)
    }
  })
})
