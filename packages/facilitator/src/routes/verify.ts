import { zValidator } from '@hono/zod-validator'
import { verifyChain } from '@hundi/core'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { errorBody } from '../errors.js'
import { verifyBodySchema } from '../schemas.js'
import { buildVerifyCtx } from '../verify-logic.js'

/** POST /verify — stateless dry-run of the mandate-chain gate. Writes nothing;
 * callers use this to preflight a cart before committing to /settlements. */
export function registerVerifyRoute(app: Hono, { db }: AppDeps): void {
  app.post('/verify', zValidator('json', verifyBodySchema), (c) => {
    const { intent, cart } = c.req.valid('json')
    const now = Math.floor(Date.now() / 1000)

    const { ctx } = buildVerifyCtx(db, intent, cart, now)
    const result = verifyChain(intent, cart, ctx)

    if (!result.ok) {
      return c.json(errorBody(result.reason, result.detail), 200)
    }
    return c.json(
      {
        ok: true,
        needsApproval: result.needsApproval,
        mandateCartHashHex: result.mandateCartHashHex,
      },
      200,
    )
  })
}
