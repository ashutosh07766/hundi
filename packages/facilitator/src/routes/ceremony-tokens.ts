import { randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { requireHeaderToken } from '../middleware.js'

/** POST /ceremony-tokens — dashboard-gated mint of a single-use token that binds the
 * next /mandates registration to whoever holds it. See ceremony_tokens in schema.sql. */
export function registerCeremonyTokenRoutes(app: Hono, { db, env }: AppDeps): void {
  app.post(
    '/ceremony-tokens',
    requireHeaderToken('x-hundi-dashboard-token', env.DASHBOARD_TOKEN),
    (c) => {
      const token = randomBytes(32).toString('hex')
      db.prepare('INSERT INTO ceremony_tokens (token) VALUES (?)').run(token)
      return c.json({ ok: true, ceremonyToken: token }, 201)
    },
  )
}
