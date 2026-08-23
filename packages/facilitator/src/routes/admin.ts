import { zValidator } from '@hono/zod-validator'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { isSqliteConstraintError, RouteError } from '../errors.js'
import { requireHeaderToken } from '../middleware.js'
import { adminMerchantBodySchema } from '../schemas.js'

/** POST /admin/merchants — create-only. A merchant's catalog prices back the
 * PRICE_MISMATCH check in verifyChain, so once registered they're immutable
 * through this route; changing prices is a separate (not yet built) surface. */
export function registerAdminRoutes(app: Hono, { db, env }: AppDeps): void {
  app.post(
    '/admin/merchants',
    requireHeaderToken('x-hundi-admin-token', env.ADMIN_TOKEN),
    zValidator('json', adminMerchantBodySchema),
    (c) => {
      const { merchant_id, name, catalog_url, config } = c.req.valid('json')

      try {
        db.prepare(
          'INSERT INTO merchants (merchant_id, name, catalog_url, config_json) VALUES (?, ?, ?, ?)',
        ).run(merchant_id, name, catalog_url ?? null, JSON.stringify(config))
      } catch (err) {
        if (isSqliteConstraintError(err)) throw new RouteError(409, 'MERCHANT_EXISTS')
        throw err
      }

      return c.json({ ok: true, merchant_id }, 201)
    },
  )
}
