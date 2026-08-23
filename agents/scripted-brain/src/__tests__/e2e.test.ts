/**
 * Boots the real store Hono app and a real facilitator Hono app in-process (real
 * HTTP over loopback, no external network, no browser) and drives the scripted
 * brain through all four demo stages: happy path to capture, an over-ceiling
 * block, an above-threshold park, and a poisoned-catalog block. A final pair of
 * tests asserts the BuyerTools surface is Razorpay-free by construction.
 *
 * The facilitator's real settlement executor isn't built yet, so each test boots
 * its own facilitator with a fake executor that marks a settlement captured
 * synchronously (mirroring makeFakeExecutor in packages/facilitator/src/__tests__/
 * http-helpers.ts, but doing the real state-machine work instead of just recording
 * a call) — everything else in the facilitator (verify gate, idempotency, ledger,
 * approval routing) is exercised unmodified.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { intentSigningBytes, verifyMandateSignature } from '@hundi/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createApp as createStoreApp } from '../../../../apps/store/src/app.js'
import { MERCHANT_ID, catalog as storeCatalog } from '../../../../apps/store/src/catalog.js'
import { POISON_PRODUCT } from '../../../../apps/store/src/poison-fixture.js'
import { createApp as createFacilitatorApp } from '../../../../packages/facilitator/src/app.js'
import { openDb, tx } from '../../../../packages/facilitator/src/db/index.js'
import { appendLedger } from '../../../../packages/facilitator/src/ledger.js'
import { transitionSettlement } from '../../../../packages/facilitator/src/state-machine.js'

import type { BuyerTools } from '../agent-tools.js'
import { HttpBuyerTools } from '../agent-tools.js'
import { generateAgentKeypair, signPayload } from '../ed25519.js'
import { runPurchase } from '../scripted-brain.js'
import { registerMandate } from '../session.js'

const TEST_ENV = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_test_webhook_secret',
  DASHBOARD_TOKEN: 'dashboard-test-token',
  ADMIN_TOKEN: 'admin-test-token',
  DB_PATH: ':memory:',
  PORT: 0,
  CHECKOUT_PAGE_PORT: 0,
}

const noopLog = () => {}

type FacilitatorDb = ReturnType<typeof openDb>

/** Immediately marks a settlement captured — stands in for the not-yet-built
 * Razorpay-backed executor so these tests can exercise capture without a real
 * payment provider. */
function makeCapturingExecutor(db: FacilitatorDb) {
  return {
    execute(settlementId: string): void {
      tx(db, () => {
        transitionSettlement(db, settlementId, 'approved', 'settling')
        db.prepare(
          `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt)
           VALUES (?, ?, 's2s_api', 'captured', ?)`,
        ).run(randomUUID(), settlementId, randomUUID())
        transitionSettlement(db, settlementId, 'settling', 'captured')
        appendLedger(db, {
          event_type: 'payment_captured',
          settlement_id: settlementId,
          actor: 'executor:fake',
          payload: {},
        })
      })
    },
  }
}

function listen(app: {
  fetch: (req: Request) => Response | Promise<Response>
}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info: AddressInfo) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          close: () => new Promise<void>((res) => server.close(() => res())),
        })
      },
    )
  })
}

let storeUrlPromise: Promise<{ url: string; close: () => Promise<void> }> | undefined
function getStore() {
  storeUrlPromise ??= listen(createStoreApp())
  return storeUrlPromise
}

let closeFacilitator: (() => Promise<void>) | undefined
afterEach(async () => {
  if (closeFacilitator) {
    await closeFacilitator()
    closeFacilitator = undefined
  }
})
afterAll(async () => {
  if (storeUrlPromise) await (await storeUrlPromise).close()
})

async function bootFacilitator(): Promise<{ url: string; db: FacilitatorDb }> {
  const db = openDb(':memory:')
  const executor = makeCapturingExecutor(db)
  const app = createFacilitatorApp({ db, executor, env: TEST_ENV })
  const facilitator = await listen(app)
  closeFacilitator = facilitator.close
  return { url: facilitator.url, db }
}

const HOUR = 3600
function future(): number {
  return Math.floor(Date.now() / 1000) + HOUR
}

describe('scripted brain — happy path', () => {
  it('registers a mandate, buys a ~₹3200 in-stock shoe, and reaches captured', async () => {
    const store = await getStore()
    const { url: facilitatorUrl, db } = await bootFacilitator()
    const tools: BuyerTools = new HttpBuyerTools({ storeUrl: store.url, facilitatorUrl })

    const { intent, agentKeyPair } = await registerMandate({
      facilitatorUrl,
      dashboardToken: TEST_ENV.DASHBOARD_TOKEN,
      goal: 'buy running shoes',
      ceiling_paise: 500_000,
      approval_threshold_paise: 400_000,
      merchants: [MERCHANT_ID],
      expires_at: future(),
    })

    // Cross-verifies the signature this package produced against core's own
    // verifier — proves ed25519.ts is genuinely compatible, not just accepted by
    // a facilitator that happens to make the same mistake.
    expect(
      verifyMandateSignature(intentSigningBytes(intent), intent.sig, {
        type: 'ed25519',
        publicKey_hex: agentKeyPair.publicKeyHex,
      }),
    ).toBe(true)

    const outcome = await runPurchase(
      {
        goal: {
          query: 'Air Runner',
          maxItems: 1,
          ceiling_paise: 500_000,
          threshold_paise: 400_000,
        },
        mandate: { intent, agent: agentKeyPair },
      },
      tools,
      noopLog,
    )

    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') throw new Error('unreachable')

    const catalogProduct = storeCatalog.find((p) => p.id === outcome.product.id)
    expect(catalogProduct).toBeDefined()
    expect(outcome.product.price_paise).toBe(catalogProduct?.price_paise)
    expect(outcome.settlement.state).toBe('captured')

    const row = db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(outcome.settlement.settlement_id) as { state: string }
    expect(row.state).toBe('captured')

    const ledgerTypes = (
      db.prepare('SELECT event_type FROM ledger_events ORDER BY seq ASC').all() as {
        event_type: string
      }[]
    ).map((e) => e.event_type)
    expect(ledgerTypes).toContain('payment_captured')
  })
})

describe('scripted brain — overspend', () => {
  it('blocks an over-ceiling cart with AMOUNT_EXCEEDS_CEILING', async () => {
    const store = await getStore()
    const { url: facilitatorUrl } = await bootFacilitator()
    const tools: BuyerTools = new HttpBuyerTools({ storeUrl: store.url, facilitatorUrl })

    const { intent, agentKeyPair } = await registerMandate({
      facilitatorUrl,
      dashboardToken: TEST_ENV.DASHBOARD_TOKEN,
      goal: 'buy a shoe',
      ceiling_paise: 500_000, // the real, registered spending limit
      approval_threshold_paise: 400_000,
      merchants: [MERCHANT_ID],
      expires_at: future(),
    })

    // goal.ceiling_paise is generous — the brain's own local filter doesn't rule
    // out the product it picks. Only the mandate's real ceiling (above) does.
    const outcome = await runPurchase(
      {
        goal: {
          query: 'Apex Motion Zenith',
          maxItems: 1,
          ceiling_paise: 1_000_000,
          threshold_paise: 400_000,
        },
        mandate: { intent, agent: agentKeyPair },
      },
      tools,
      noopLog,
    )

    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') throw new Error('unreachable')
    expect(outcome.settlement?.reason).toBe('AMOUNT_EXCEEDS_CEILING')
  })
})

describe('scripted brain — approval routing', () => {
  it('parks an above-threshold cart as pending_approval and records a rationale', async () => {
    const store = await getStore()
    const { url: facilitatorUrl, db } = await bootFacilitator()
    const tools: BuyerTools = new HttpBuyerTools({ storeUrl: store.url, facilitatorUrl })

    const { intent, agentKeyPair } = await registerMandate({
      facilitatorUrl,
      dashboardToken: TEST_ENV.DASHBOARD_TOKEN,
      goal: 'buy a shoe',
      ceiling_paise: 500_000,
      approval_threshold_paise: 400_000,
      merchants: [MERCHANT_ID],
      expires_at: future(),
    })

    const outcome = await runPurchase(
      {
        goal: {
          query: 'Air Runner Pro',
          maxItems: 1,
          ceiling_paise: 500_000,
          threshold_paise: 400_000,
        },
        mandate: { intent, agent: agentKeyPair },
      },
      tools,
      noopLog,
    )

    expect(outcome.status).toBe('pending_approval')
    if (outcome.status !== 'pending_approval') throw new Error('unreachable')
    expect(outcome.settlement.state).toBe('pending_approval')

    const ledgerTypes = (
      db
        .prepare('SELECT event_type FROM ledger_events WHERE settlement_id = ? ORDER BY seq ASC')
        .all(outcome.settlement.settlement_id) as { event_type: string }[]
    ).map((e) => e.event_type)
    expect(ledgerTypes).toContain('agent_decision')
  })
})

describe('scripted brain — prompt injection via poisoned catalog', () => {
  it('naively selects the poisoned SKU but the facilitator blocks it structurally', async () => {
    const store = await getStore()
    const { url: facilitatorUrl } = await bootFacilitator()
    const tools: BuyerTools = new HttpBuyerTools({
      storeUrl: store.url,
      facilitatorUrl,
      poisonedCatalog: true,
    })

    const { intent, agentKeyPair } = await registerMandate({
      facilitatorUrl,
      dashboardToken: TEST_ENV.DASHBOARD_TOKEN,
      goal: 'buy a trail shoe',
      ceiling_paise: 400_000, // below the poisoned listing's declared price
      approval_threshold_paise: 200_000,
      merchants: [MERCHANT_ID],
      expires_at: future(),
    })

    // A generous local search ceiling — the brain has no idea one of its "trail"
    // matches is a poisoned listing; it just picks the cheapest in-stock one.
    const outcome = await runPurchase(
      {
        goal: { query: 'trail', maxItems: 1, ceiling_paise: 1_000_000, threshold_paise: 200_000 },
        mandate: { intent, agent: agentKeyPair },
      },
      tools,
      noopLog,
    )

    expect(outcome.status).toBe('blocked')
    if (outcome.status !== 'blocked') throw new Error('unreachable')

    // Confirms this was a genuine "naively followed the poison SKU" run, not an
    // incidental block on an unrelated legitimate product.
    expect(outcome.product?.id).toBe(POISON_PRODUCT.id)
    expect(['AMOUNT_EXCEEDS_CEILING', 'MERCHANT_NOT_IN_SCOPE', 'PRICE_MISMATCH']).toContain(
      outcome.settlement?.reason,
    )
  })
})

describe('BuyerTools — Razorpay-free by construction', () => {
  const srcDir = fileURLToPath(new URL('..', import.meta.url))

  it('never references a payment provider anywhere in this package', () => {
    for (const file of ['agent-tools.ts', 'scripted-brain.ts', 'session.ts', 'ed25519.ts']) {
      const source = readFileSync(`${srcDir}${file}`, 'utf8')
      expect(source, `${file} must not reference a payment provider`).not.toMatch(/razorpay/i)
    }
  })

  it('exposes exactly the swap-the-brain method surface — no settle/capture/refund method', () => {
    const methodNames = Object.getOwnPropertyNames(HttpBuyerTools.prototype).filter(
      (name) => name !== 'constructor',
    )
    expect(new Set(methodNames)).toEqual(
      new Set([
        'searchCatalog',
        'getProduct',
        'proposeCart',
        'requestPayment',
        'recordDecision',
        'pollSettlement',
      ]),
    )
  })

  it('requestPayment only ever calls URLs under the configured facilitator base', async () => {
    const calledUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      calledUrls.push(url)
      if (url.endsWith('/settlements')) {
        return new Response(
          JSON.stringify({ ok: true, settlement_id: 'fake-1', state: 'approved' }),
          { status: 202 },
        )
      }
      return new Response(
        JSON.stringify({ ok: true, settlement: { state: 'captured', reject_reason: null } }),
        { status: 200 },
      )
    }) as typeof fetch

    try {
      const tools = new HttpBuyerTools({
        storeUrl: 'http://127.0.0.1:1',
        facilitatorUrl: 'http://127.0.0.1:2/facilitator',
      })
      const agent = generateAgentKeypair()
      const unsignedIntent = {
        mandateId: 'structural-test-mandate',
        goal: 'structural test',
        ceiling_paise: 100_000,
        approval_threshold_paise: 50_000,
        currency: 'INR' as const,
        merchants: ['m'],
        expires_at: future(),
        agent_pubkey_hex: agent.publicKeyHex,
      }
      const intent = {
        ...unsignedIntent,
        sig: signPayload(agent.privateKey, intentSigningBytes(unsignedIntent)),
      }

      await tools.requestPayment({
        intent,
        cart: {
          merchant_id: 'm',
          items: [{ sku: 's', qty: 1, unit_price_paise: 100 }],
          total_paise: 100,
        },
        agent,
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calledUrls.length).toBeGreaterThan(0)
    for (const url of calledUrls) {
      expect(url.startsWith('http://127.0.0.1:2/facilitator')).toBe(true)
      expect(url.toLowerCase()).not.toContain('razorpay')
    }
  })
})
