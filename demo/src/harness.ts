/**
 * Boots a real store Hono app and a real facilitator Hono app in-process
 * (loopback HTTP, no external network, no browser) — the same harness shape
 * proven in agents/scripted-brain/src/__tests__/e2e.test.ts, generalized so
 * every demo stage can share it. `createHarness()` returns one facilitator
 * instance (fresh in-memory db) wired to the REAL executor
 * (packages/facilitator/src/executor.ts) driven by a controllable fake
 * driver + fake Razorpay client — no real network call, real browser, or
 * real payment ever happens here, but the attempt-loop / retry /
 * payment-link-fallback logic that runs is the facilitator's actual
 * production code, not a stand-in for it.
 *
 * Two callers use this module differently: the vitest suite calls
 * `createHarness()` once per test for full isolation (mirroring
 * `bootFacilitator()` in the e2e suite); `run-all.ts` calls it once and
 * drives all six stages through the same instance, so the ledger printed at
 * the end is one continuous chain across the whole demo run.
 */

import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { SigEnvelope } from '@hundi/core'
import { canonicalJson } from '@hundi/core'
import type { AgentKeypair } from '../../agents/scripted-brain/src/ed25519.js'
import { signPayload } from '../../agents/scripted-brain/src/ed25519.js'
import { createApp as createStoreApp } from '../../apps/store/src/app.js'
import { MERCHANT_ID } from '../../apps/store/src/catalog.js'
import {
  captured,
  failed,
  makeFakeRazorpay,
} from '../../packages/facilitator/src/__tests__/executor-helpers.js'
import { createApp as createFacilitatorApp } from '../../packages/facilitator/src/app.js'
import { openDb } from '../../packages/facilitator/src/db/index.js'
import type { Env } from '../../packages/facilitator/src/env.js'
import type {
  Executor,
  ExecutorTestHooks,
  SettleDriver,
} from '../../packages/facilitator/src/executor.js'
import { createExecutor } from '../../packages/facilitator/src/executor.js'
import { GENESIS_HASH, verifyLedger } from '../../packages/facilitator/src/ledger.js'
import type { RazorpayClient } from '../../packages/facilitator/src/razorpay-client.js'

export type { AgentKeypair }
export { MERCHANT_ID }

/** better-sqlite3's Database type, inferred rather than imported directly —
 * demo doesn't declare better-sqlite3 as its own dependency (nothing here
 * constructs one; every db instance comes from the facilitator's own
 * `openDb`), matching the same `ReturnType<typeof openDb>` pattern the
 * scripted-brain e2e suite uses for the same reason. */
export type FacilitatorDb = ReturnType<typeof openDb>

/** The dashboard-authenticated caller mints ceremony tokens with this — see
 * session.ts's registerMandate, which is the only place demo stages need it. */
export const DASHBOARD_TOKEN = 'demo-dashboard-token'

export const TEST_ENV: Env = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_test_webhook_secret',
  DASHBOARD_TOKEN,
  ADMIN_TOKEN: 'demo-admin-token',
  DB_PATH: ':memory:',
  PORT: 0,
  CHECKOUT_PAGE_PORT: 0,
  SWEEP_INTERVAL_MS: 12_000,
  APPROVAL_TTL_MS: 1_800_000,
}

/** The mandate's registered ceiling — the real, server-enforced spending limit
 * every stage's mandate registers against. */
export const CEILING_PAISE = 400_000
/** The mandate's registered approval threshold — carts above this park as
 * `pending_approval` until a human signs a decision. */
export const THRESHOLD_PAISE = 350_000

/** Unix seconds `offsetSec` in the future — every mandate in this demo expires
 * comfortably past the run, so `MANDATE_EXPIRED` never masks the rejection a
 * stage is actually demonstrating. */
export function future(offsetSec = 3600): number {
  return Math.floor(Date.now() / 1000) + offsetSec
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

let storePromise: Promise<{ url: string; close: () => Promise<void> }> | undefined
/** The store is stateless and read-only, so every harness in a process shares
 * one instance instead of paying a fresh listen() per stage/test. */
function getStore(): Promise<{ url: string; close: () => Promise<void> }> {
  storePromise ??= listen(createStoreApp())
  return storePromise
}

/** Closes the shared store listener — call once from a test suite's `afterAll`.
 * run-all.ts never calls this; the process exit tears the listener down. */
export async function closeStore(): Promise<void> {
  if (!storePromise) return
  await (await storePromise).close()
  storePromise = undefined
}

/** Flips what the next `settleViaCheckout` call returns — swaps the whole
 * attempt-loop's outcome (immediate capture vs. exhausting all retries) without
 * rebuilding the executor, so one facilitator instance can play both stage 1's
 * happy path and stage 5's failure-recovery scenario. */
export type DriverController = { mode: 'captured' | 'failed' }

function makeControllableDriver(controller: DriverController): SettleDriver {
  return {
    async settleViaCheckout() {
      return controller.mode === 'captured'
        ? captured()
        : failed('scripted failure for demo stage 5')
    },
  }
}

export type DemoHarness = {
  storeUrl: string
  facilitatorUrl: string
  db: FacilitatorDb
  razorpay: RazorpayClient
  driverController: DriverController
  executor: Executor & ExecutorTestHooks
  close(): Promise<void>
}

/** Boots one facilitator instance: fresh in-memory db, the real executor
 * (packages/facilitator/src/executor.ts) wired to a controllable fake driver
 * and a fake Razorpay client. Every stage function takes a `DemoHarness` as
 * its only dependency — see harness usage notes in the file header for who
 * creates one and when. */
export async function createHarness(): Promise<DemoHarness> {
  const store = await getStore()
  const db = openDb(':memory:')
  const razorpay = makeFakeRazorpay()
  const driverController: DriverController = { mode: 'captured' }
  const driver = makeControllableDriver(driverController)
  const executor = createExecutor({ db, env: TEST_ENV, driver, razorpay })
  const app = createFacilitatorApp({ db, executor, env: TEST_ENV, razorpay })
  const facilitator = await listen(app)

  return {
    storeUrl: store.url,
    facilitatorUrl: facilitator.url,
    db,
    razorpay,
    driverController,
    executor,
    close: facilitator.close,
  }
}

export function ledgerEventTypesFor(db: FacilitatorDb, settlementId?: string): string[] {
  const rows = settlementId
    ? (db
        .prepare('SELECT event_type FROM ledger_events WHERE settlement_id = ? ORDER BY seq ASC')
        .all(settlementId) as { event_type: string }[])
    : (db.prepare('SELECT event_type FROM ledger_events ORDER BY seq ASC').all() as {
        event_type: string
      }[])
  return rows.map((r) => r.event_type)
}

/** The chain head as of right now — verifyLedger recomputes every row rather
 * than trusting the last row's stored hash, so this doubles as an integrity
 * check every time run-all.ts prints it. Returns the genesis constant
 * (re-exported so callers can recognize it) on an empty ledger. */
export function ledgerHead(db: FacilitatorDb): string {
  const result = verifyLedger(db)
  if (!result.ok) {
    throw new Error(`ledger integrity check failed at seq ${result.brokenAtSeq}`)
  }
  return result.head
}

export { GENESIS_HASH }

export type SettlementSnapshot = {
  settlement: {
    id: string
    state: string
    reject_reason: string | null
    mandate_cart_hash_hex: string
    [key: string]: unknown
  }
}

/** Mirrors what a real dashboard does before signing an approval decision:
 * fetch the settlement and read its server-computed `mandate_cart_hash_hex`
 * off the row, rather than recomputing it client-side from a cart the caller
 * may not have kept around (HttpBuyerTools never returns the signed
 * CartMandate it built — see agent-tools.ts's BuyerTools contract). */
export async function getSettlement(
  facilitatorUrl: string,
  settlementId: string,
): Promise<SettlementSnapshot> {
  const res = await fetch(`${facilitatorUrl}/settlements/${settlementId}`)
  if (!res.ok) throw new Error(`getSettlement: facilitator returned ${res.status}`)
  return (await res.json()) as SettlementSnapshot
}

export async function postApproval(
  facilitatorUrl: string,
  body: {
    settlement_id: string
    mandate_cart_hash_hex: string
    decision: 'approved' | 'rejected'
    sig: SigEnvelope
  },
): Promise<{ ok: boolean; state?: string; error?: string }> {
  const res = await fetch(`${facilitatorUrl}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { ok: boolean; state?: string; error?: string }
}

export async function postRevoke(
  facilitatorUrl: string,
  body: { mandateId: string; sig: SigEnvelope },
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${facilitatorUrl}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { ok: boolean; error?: string }
}

/** Signs the exact byte shape POST /approvals verifies (routes/approvals.ts):
 * `canonicalJson({ settlement_id, mandate_cart_hash_hex, decision })`. The
 * route verifies this against the mandate's *registered credential* — the human
 * key bound at ceremony time (session.ts's registerMandate) — so `signer` must
 * be the human keypair, not the agent key. The agent key cannot produce a valid
 * approval; that separation is the human-in-the-loop gate's second factor. */
export function signApprovalDecision(
  signer: AgentKeypair,
  args: { settlementId: string; mandateCartHashHex: string; decision: 'approved' | 'rejected' },
): SigEnvelope {
  const bytes = canonicalJson({
    settlement_id: args.settlementId,
    mandate_cart_hash_hex: args.mandateCartHashHex,
    decision: args.decision,
  })
  return signPayload(signer.privateKey, bytes)
}

/** Signs the exact byte shape POST /revoke verifies (routes/revoke.ts):
 * `canonicalJson({ mandateId, action: 'revoke' })`. Verified against the
 * registered (human) credential — pass the human keypair, same as
 * signApprovalDecision. */
export function signRevoke(signer: AgentKeypair, mandateId: string): SigEnvelope {
  const bytes = canonicalJson({ mandateId, action: 'revoke' })
  return signPayload(signer.privateKey, bytes)
}

export type { RazorpayClient }
