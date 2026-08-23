import type { MiddlewareHandler } from 'hono'
import { RouteError } from './errors.js'

/** Rejects with 401 unless `headerName` exactly matches `expected`. Constant-string
 * comparison is acceptable here — these are long random tokens, not passwords subject
 * to online guessing, and Node's string equality is already not naively timing-safe
 * to defend against in an HTTP handler without a much larger threat-model discussion. */
export function requireHeaderToken(headerName: string, expected: string): MiddlewareHandler {
  return async (c, next) => {
    const provided = c.req.header(headerName)
    if (provided !== expected) throw new RouteError(401, 'UNAUTHORIZED')
    await next()
  }
}
