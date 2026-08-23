#!/usr/bin/env tsx
// Manual live-integration smoke test for the U7 settle executor. Registers a
// mandate and a below-threshold settlement entirely in-process (no HTTP layer),
// runs the REAL executor (real checkout driver, real headless browser, real
// Razorpay TEST-mode API calls), and confirms capture independently via
// GET /orders/:id/payments. Not run in CI — costs a real (test-mode) payment
// and a real browser session. Needs RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in
// the environment: `pnpm smoke:settle` (reads the repo-root .env via tsx's
// --env-file flag, see package.json).

import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { intentSigningBytes, sha256Hex } from '@hundi/core'
import { credentialFor, makeCart, makeIntent } from '../src/__tests__/fixtures.js'
import { openDb, tx } from '../src/db/index.js'
import { loadEnv } from '../src/env.js'
import { createExecutor } from '../src/executor.js'
import { encodeCredentialPublicKey } from '../src/mandate-repo.js'
import { createCheckoutDriver } from '../src/rails/checkout-driver.js'
import { createRazorpayClient } from '../src/razorpay-client.js'
import { createSettlement } from '../src/settlement-service.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const db = openDb(':memory:')
  const now = Math.floor(Date.now() / 1000)

  const { intent, agent } = makeIntent({
    overrides: {
      ceiling_paise: 50_000,
      approval_threshold_paise: 50_000, // everything below-threshold: auto-approves, no /approvals dance
      merchants: ['smoke-merchant'],
      expires_at: now + 3600,
    },
  })
  const credential = credentialFor(agent)
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

  const cart = makeCart({
    agent,
    intent,
    items: [{ sku: 'smoke-sku', qty: 1, unit_price_paise: 100 }], // ₹1 — real money in TEST mode
    overrides: { merchant_id: 'smoke-merchant', cartId: `smoke-${Date.now()}` },
  })

  const settlementId = randomUUID()
  const outcome = tx(db, () => createSettlement(db, settlementId, intent, cart, now))
  if (!outcome.body.ok || outcome.body.state !== 'approved') {
    console.error('smoke: settlement did not reach approved', outcome.body)
    process.exit(1)
  }
  console.log(`smoke: settlement ${settlementId} approved — running the real executor`)

  const razorpay = createRazorpayClient({
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
  })
  const driver = createCheckoutDriver({
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    razorpay,
    checkoutPagePort: env.CHECKOUT_PAGE_PORT,
  })
  const executor = createExecutor({ db, env, driver })
  executor.execute(settlementId)
  await executor.waitForIdle()

  const settlement = db.prepare('SELECT state FROM settlements WHERE id = ?').get(settlementId) as {
    state: string
  }
  const attempt = db
    .prepare(
      `SELECT provider_order_id, provider_payment_id FROM settlement_attempts
       WHERE settlement_id = ? AND state = 'captured'`,
    )
    .get(settlementId) as { provider_order_id: string; provider_payment_id: string } | undefined

  if (settlement.state !== 'captured' || !attempt) {
    console.error('smoke: settlement did not capture', { state: settlement.state })
    process.exit(1)
  }

  const payments = await razorpay.fetchOrderPayments(attempt.provider_order_id)
  const captured = payments.find(
    (p) => p.id === attempt.provider_payment_id && p.status === 'captured',
  )
  if (!captured) {
    console.error('smoke: GET /orders/:id/payments did not confirm capture', payments)
    process.exit(1)
  }

  console.log(`smoke: OK — settlement ${settlementId} captured, payment ${captured.id}`)
}

main().catch((err) => {
  console.error('smoke: fatal', err)
  process.exit(1)
})
