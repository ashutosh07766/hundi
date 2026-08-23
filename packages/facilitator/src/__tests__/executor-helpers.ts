/**
 * Executor-test-only fixtures: build a real, fully-signed, `approved`
 * settlement entirely in-process (bypassing HTTP) so executor tests exercise
 * the real verify chain — same discipline as fixtures.ts, one level up the
 * stack. Also carries fake RazorpayClient / SettleDriver builders so
 * executor tests never touch the network or a browser.
 */

import type { CartItem, Credential, IntentMandate } from '@hundi/core'
import { intentSigningBytes, sha256Hex } from '@hundi/core'
import type Database from 'better-sqlite3'
import { tx } from '../db/index.js'
import type { RunnerDeps, SettleDriver } from '../executor.js'
import { encodeCredentialPublicKey } from '../mandate-repo.js'
import type { SettleViaCheckoutResult } from '../rails/checkout-driver.js'
import type {
  RazorpayClient,
  RazorpayOrder,
  RazorpayPayment,
  RazorpayPaymentLink,
  RazorpayRefund,
} from '../razorpay-client.js'
import { createSettlement } from '../settlement-service.js'
import { makeCart, makeIntent } from './fixtures.js'

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

/** Registers a mandate directly (mirrors routes/mandates.ts's writes, minus the
 * ceremony-token dance) so executor tests don't need the HTTP layer. */
export function registerMandateDirect(db: Database.Database, intent: IntentMandate): void {
  // The mandate's registered credential is the same ed25519 key that signed the
  // intent — fixtures.ts's makeIntent always signs with `intent.agent_pubkey_hex`.
  const credential: Credential = { type: 'ed25519', publicKey_hex: intent.agent_pubkey_hex }
  const intentHashHex = sha256Hex(intentSigningBytes(intent))
  db.prepare(
    `INSERT INTO mandates (mandate_id, intent_json, intent_hash_hex, credential_type, credential_public_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    intent.mandateId,
    JSON.stringify(intent),
    intentHashHex,
    credential.type,
    encodeCredentialPublicKey(credential),
  )
  db.prepare(
    'INSERT INTO allowances (mandate_id, max_amount_paise, expires_at) VALUES (?, ?, ?)',
  ).run(intent.mandateId, intent.ceiling_paise, intent.expires_at)
}

export type ApprovedFixture = {
  settlementId: string
  intent: IntentMandate
  mandateId: string
}

/**
 * Builds a mandate + a below-threshold settlement and drives it to `approved`
 * via the real createSettlement service (real signature checks, real verify
 * chain) — no HTTP layer involved. `now` and `expiresAt` are both exposed so
 * TOCTOU tests can create the settlement at one clock reading and re-verify
 * (via runOnce) at a later one.
 */
export function makeApprovedSettlement(
  db: Database.Database,
  opts: {
    now: number
    expiresAt: number
    merchantId?: string
    amountPaise?: number
    items?: CartItem[]
  },
): ApprovedFixture {
  const merchantId = opts.merchantId ?? 'merchant-1'
  const amountPaise = opts.amountPaise ?? 100_000
  const { intent, agent } = makeIntent({
    overrides: {
      ceiling_paise: amountPaise + 1,
      approval_threshold_paise: amountPaise, // strictly below threshold => auto-approves
      merchants: [merchantId],
      expires_at: opts.expiresAt,
    },
  })
  registerMandateDirect(db, intent)

  const cart = makeCart({
    agent,
    intent,
    items: opts.items ?? [{ sku: 'sku-1', qty: 1, unit_price_paise: amountPaise }],
    overrides: { merchant_id: merchantId, cartId: nextId('cart') },
  })

  const settlementId = nextId('settlement')
  const outcome = tx(db, () => createSettlement(db, settlementId, intent, cart, opts.now))
  if (!outcome.body.ok || outcome.body.state !== 'approved') {
    throw new Error(`fixture did not reach approved: ${JSON.stringify(outcome.body)}`)
  }
  return { settlementId, intent, mandateId: intent.mandateId }
}

export function makeFakeRazorpay(
  overrides: Partial<RazorpayClient> = {},
): RazorpayClient & { orders: RazorpayOrder[]; links: RazorpayPaymentLink[] } {
  const orders: RazorpayOrder[] = []
  const links: RazorpayPaymentLink[] = []
  return {
    orders,
    links,
    async createOrder({ amountPaise, receipt }) {
      const order: RazorpayOrder = {
        id: nextId('order'),
        amount: amountPaise,
        currency: 'INR',
        receipt,
        status: 'created',
      }
      orders.push(order)
      return order
    },
    async createPaymentLink({ referenceId }) {
      const link: RazorpayPaymentLink = {
        id: nextId('plink'),
        short_url: `https://rzp.io/l/${referenceId}`,
        status: 'created',
      }
      links.push(link)
      return link
    },
    async refundPayment({ paymentId }) {
      const refund: RazorpayRefund = {
        id: nextId('rfnd'),
        payment_id: paymentId,
        status: 'processed',
        amount: 0,
      }
      return refund
    },
    async fetchOrderPayments(): Promise<RazorpayPayment[]> {
      return []
    },
    ...overrides,
  }
}

/** Scripts a fixed sequence of driver results, one per call — the last entry repeats
 * for any call beyond the scripted length. */
export function makeScriptedDriver(
  results: SettleViaCheckoutResult[],
): SettleDriver & { calls: Parameters<SettleDriver['settleViaCheckout']>[0][] } {
  const calls: Parameters<SettleDriver['settleViaCheckout']>[0][] = []
  return {
    calls,
    async settleViaCheckout(args) {
      calls.push(args)
      const idx = Math.min(calls.length - 1, results.length - 1)
      const result = results[idx]
      if (!result) throw new Error('makeScriptedDriver: no results scripted')
      return result
    },
  }
}

export function captured(paymentId = nextId('pay')): SettleViaCheckoutResult {
  return { ok: true, paymentId, status: 'captured', detectedVia: 'api-poll', latencyMs: 1 }
}

export function failed(error = 'mock bank did not resolve'): SettleViaCheckoutResult {
  return { ok: false, status: 'failed', detectedVia: 'api-poll', latencyMs: 1, error }
}

export function baseRunnerDeps(db: Database.Database): Omit<RunnerDeps, 'driver'> {
  return {
    db,
    razorpay: makeFakeRazorpay(),
    now: () => Math.floor(Date.now() / 1000),
  }
}
