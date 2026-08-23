import type { ScanResult } from '@hundi/cli/scanner'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './env.js'
import { errorBody, RouteError } from './errors.js'
import type { Executor } from './executor.js'
import type { RazorpayClient } from './razorpay-client.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerCeremonyTokenRoutes } from './routes/ceremony-tokens.js'
import { registerMandateRoutes } from './routes/mandates.js'
import { registerReadRoutes } from './routes/read.js'
import { registerRevokeRoute } from './routes/revoke.js'
import { registerSettlementRoutes } from './routes/settlements.js'
import { registerStoreRoutes } from './routes/stores.js'
import { registerVerifyRoute } from './routes/verify.js'
import { registerWebhookRoutes } from './routes/webhook.js'

/** The dashboard's local dev origin — the only browser origin ever allowed to call
 * this API directly. Any other consumer (agents, s2s) doesn't send an Origin header
 * a browser CORS check inspects, so this list has no reason to grow. */
const DASHBOARD_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

export type AppDeps = {
  db: Database.Database
  executor: Executor
  env: Env
  razorpay: RazorpayClient
  /** Defaults to the real `@hundi/cli/scanner` scanStore at the route layer (see
   * routes/stores.ts) — overridable here so tests can onboard a store without making a
   * real network request. */
  scanStore?: (url: string) => Promise<ScanResult>
}

/** Builds the Hono app with `deps` injected — tests pass an in-memory db and a
 * fake executor; serve.ts passes the real DB file and (for now) `noopExecutor`. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()

  app.use('*', cors({ origin: DASHBOARD_ORIGINS }))

  app.onError((err, c) => {
    if (err instanceof RouteError) {
      return c.json(errorBody(err.code, err.detail), err.status)
    }
    // Fail loud: an unexpected error is a bug, not a 200-with-empty-data response.
    console.error(err)
    return c.json({ ok: false, error: 'INTERNAL_ERROR' }, 500)
  })

  registerCeremonyTokenRoutes(app, deps)
  registerMandateRoutes(app, deps)
  registerVerifyRoute(app, deps)
  registerSettlementRoutes(app, deps)
  registerApprovalRoutes(app, deps)
  registerRevokeRoute(app, deps)
  registerAdminRoutes(app, deps)
  registerWebhookRoutes(app, deps)
  registerReadRoutes(app, deps)
  registerStoreRoutes(app, deps)

  return app
}
