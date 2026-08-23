/**
 * Boots a real store Hono app and a real facilitator Hono app in-process
 * (loopback HTTP, no external network, no browser) — the same shape used by
 * demo/src/harness.ts and agents/scripted-brain/src/__tests__/e2e.test.ts.
 * `createHarness()` wires the REAL executor (packages/facilitator/src/
 * executor.ts) to a controllable fake driver and a fake Razorpay client, so
 * the attempt-loop / retry / payment-link-fallback logic that runs is the
 * facilitator's actual production code, not a stand-in for it. No real
 * network call, real browser, or real payment ever happens here — the real
 * rail is proven separately (packages/facilitator/bin/smoke-settle.ts,
 * pay_TTBO5gj6lma2uw).
 *
 * demo/package.json declares no "main"/"exports", so it can't be imported as
 * a package — this file is an independent copy of the same harness shape,
 * extended with a third driver mode (`fail-then-capture`) the batch harness
 * needs for its retry-recovery task. Keep both copies behaviorally aligned:
 * a change to how the real executor/verify chain is wired here should be
 * mirrored in demo/src/harness.ts, and vice versa.
 */

import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { SigEnvelope } from '@hundi/core'
import { canonicalJson } from '@hundi/core'
import type { AgentKeypair } from '../../../agents/scripted-brain/src/ed25519.js'
import { signPayload } from '../../../agents/scripted-brain/src/ed25519.js'
import { createApp as createStoreApp } from '../../../apps/store/src/app.js'
import { MERCHANT_ID } from '../../../apps/store/src/catalog.js'
import {
  captured,
  failed,
  makeFakeRazorpay,
} from '../../facilitator/src/__tests__/executor-helpers.js'
import { createApp as createFacilitatorApp } from '../../facilitator/src/app.js'
import { openDb } from '../../facilitator/src/db/index.js'
import type { Env } from '../../facilitator/src/env.js'
import type { Executor, ExecutorTestHooks, SettleDriver } from '../../facilitator/src/executor.js'
import { createExecutor } from '../../facilitator/src/executor.js'
import { GENESIS_HASH, verifyLedger } from '../../facilitator/src/ledger.js'
import type { RazorpayClient } from '../../facilitator/src/razorpay-client.js'

export type { AgentKeypair, RazorpayClient }
export { GENESIS_HASH, MERCHANT_ID }

/** better-sqlite3's Database type, inferred rather than imported directly — this
 * package doesn't declare better-sqlite3 as its own dependency; every db instance
 * comes from the facilitator's own `openDb`. */
export type FacilitatorDb = ReturnType<typeof openDb>

/** The dashboard-authenticated caller mints ceremony tokens with this — the only
 * place a task needs it is registerMandate (agents/scripted-brain/src/session.ts). */
export const DASHBOARD_TOKEN = 'batch-harness-dashboard-token'

export const TEST_ENV: Env = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_test_webhook_secret',
  DASHBOARD_TOKEN,
  ADMIN_TOKEN: 'batch-harness-admin-token',
  DB_PATH: ':memory:',
  PORT: 0,
  CHECKOUT_PAGE_PORT: 0,
  SWEEP_INTERVAL_MS: 12_000,
  APPROVAL_TTL_MS: 1_800_000,
}

/** Unix seconds `offsetSec` in the future — every mandate this harness registers
 * expires comfortably past the run, so MANDATE_EXPIRED never masks the rejection
 * a task is actually exercising. */
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
 * one instance instead of paying a fresh listen() per task. */
function getStore(): Promise<{ url: string; close: () => Promise<void> }> {
  storePromise ??= listen(createStoreApp())
  return storePromise
}

/** Closes the shared store listener — call once after the whole batch finishes. */
export async function closeStore(): Promise<void> {
  if (!storePromise) return
  await (await storePromise).close()
  storePromise = undefined
}

/**
 * What the next `settleViaCheckout` call returns. `'captured'`/`'failed'` are
 * sticky (every call returns the same outcome) — the same shape demo/src/
 * harness.ts uses for its six scripted stages. `'fail-then-capture'` adds a
 * third mode this harness needs for its retry task: the first call in the
 * mode fails, every call after that captures. `callCount` must be reset to 0
 * whenever a task switches the controller into `'fail-then-capture'` — it is
 * not reset automatically, since the controller is shared across the whole
 * batch run and a stale count would desync attempt numbering from task to
 * task.
 */
export type DriverController = {
  mode: 'captured' | 'failed' | 'fail-then-capture'
  callCount: number
}

function makeControllableDriver(controller: DriverController): SettleDriver {
  return {
    async settleViaCheckout() {
      if (controller.mode === 'captured') return captured()
      if (controller.mode === 'failed') return failed('scripted failure for batch harness')
      controller.callCount += 1
      return controller.callCount === 1
        ? failed('scripted first-attempt failure for retry-to-capture task')
        : captured()
    },
  }
}

export type BatchHarness = {
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
 * and a fake Razorpay client. Every task in the batch runs against the same
 * `BatchHarness` instance, so the ledger printed at the end is one continuous
 * chain across the whole run — same discipline as demo/src/run-all.ts. */
export async function createHarness(): Promise<BatchHarness> {
  const store = await getStore()
  const db = openDb(':memory:')
  const razorpay = makeFakeRazorpay()
  const driverController: DriverController = { mode: 'captured', callCount: 0 }
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

/** The chain head as of right now — verifyLedger recomputes every row rather than
 * trusting the last row's stored hash, so this doubles as an integrity check every
 * time the runner prints it. Returns the genesis constant on an empty ledger. */
export function ledgerHead(db: FacilitatorDb): string {
  const result = verifyLedger(db)
  if (!result.ok) {
    throw new Error(`ledger integrity check failed at seq ${result.brokenAtSeq}`)
  }
  return result.head
}

export type SettlementSnapshot = {
  settlement: {
    id: string
    state: string
    reject_reason: string | null
    mandate_cart_hash_hex: string
    [key: string]: unknown
  }
}

/** Mirrors what a real dashboard does before signing an approval decision: fetch
 * the settlement and read its server-computed `mandate_cart_hash_hex` off the row,
 * rather than recomputing it client-side from a cart the caller may not have kept
 * around (HttpBuyerTools never returns the signed CartMandate it built). */
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

/** Signs the exact byte shape POST /approvals verifies (routes/approvals.ts):
 * `canonicalJson({ settlement_id, mandate_cart_hash_hex, decision })`. The
 * registered credential is the same ed25519 key bound at ceremony time — no
 * separate WebAuthn human passkey exists yet, so "the human's key" and "the
 * agent's key" are the same bits here. The route itself already verifies
 * against the mandate's *registered credential*, not the agent's operational
 * key by name — swapping in a real passkey ceremony later requires no
 * server-side change, only a different signer. */
export function signApprovalDecision(
  agent: AgentKeypair,
  args: { settlementId: string; mandateCartHashHex: string; decision: 'approved' | 'rejected' },
): SigEnvelope {
  const bytes = canonicalJson({
    settlement_id: args.settlementId,
    mandate_cart_hash_hex: args.mandateCartHashHex,
    decision: args.decision,
  })
  return signPayload(agent.privateKey, bytes)
}
