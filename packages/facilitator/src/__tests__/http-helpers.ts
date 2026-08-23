import type { Credential, IntentMandate } from '@hundi/core'
import type { Hono } from 'hono'
import { createApp } from '../app.js'
import type { Env } from '../env.js'
import type { Executor } from '../executor.js'
import type { RazorpayClient } from '../razorpay-client.js'
import { makeFakeRazorpay } from './executor-helpers.js'
import { openTestDb } from './helpers.js'

export function makeFakeExecutor(): Executor & { calls: string[]; resumeCalls: string[] } {
  const calls: string[] = []
  const resumeCalls: string[] = []
  return {
    calls,
    resumeCalls,
    execute(settlementId: string): void {
      calls.push(settlementId)
    },
    resumeSettling(settlementId: string): void {
      resumeCalls.push(settlementId)
    },
  }
}

export const TEST_ENV: Env = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp_test_webhook_secret',
  DASHBOARD_TOKEN: 'dashboard-test-token',
  ADMIN_TOKEN: 'admin-test-token',
  DB_PATH: ':memory:',
  PORT: 8790,
  CHECKOUT_PAGE_PORT: 8788,
  SWEEP_INTERVAL_MS: 12_000,
  APPROVAL_TTL_MS: 1_800_000,
}

/** Fresh in-memory-db app + fake executor per call, matching openTestDb's "tests never
 * share state" discipline. Returns the app plus the db/executor/razorpay handles tests
 * need to assert on directly (executor.calls, razorpay spies, or driving the db
 * out-of-band). `razorpay` defaults to the same in-memory fake executor-helpers.ts
 * tests use — pass one in to control fetchOrderPayments for webhook tests. */
export function makeTestApp(opts: { razorpay?: RazorpayClient } = {}): {
  app: Hono
  db: ReturnType<typeof openTestDb>
  executor: Executor & { calls: string[]; resumeCalls: string[] }
  razorpay: RazorpayClient
} {
  const db = openTestDb()
  const executor = makeFakeExecutor()
  const razorpay = opts.razorpay ?? makeFakeRazorpay()
  const app = createApp({ db, executor, env: TEST_ENV, razorpay })
  return { app, db, executor, razorpay }
}

export async function postJson(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

export async function getJson(
  app: Hono,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, { method: 'GET', headers })
}

export async function mintCeremonyToken(app: Hono): Promise<string> {
  const res = await postJson(
    app,
    '/ceremony-tokens',
    {},
    { 'x-hundi-dashboard-token': TEST_ENV.DASHBOARD_TOKEN },
  )
  const json = (await res.json()) as { ceremonyToken: string }
  return json.ceremonyToken
}

/** Runs the full ceremony (mint token, register) for a fresh mandate. Callers that need
 * to exercise ceremony-token mechanics directly (single-use, missing token) call
 * mintCeremonyToken / postJson('/mandates', ...) themselves instead. */
export async function registerMandate(
  app: Hono,
  intent: IntentMandate,
  credential: Credential,
): Promise<Response> {
  const ceremonyToken = await mintCeremonyToken(app)
  return postJson(app, '/mandates', { intent, credential, ceremonyToken })
}
