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

/** Accepts EITHER the dashboard token OR the narrow onboard token (when
 * configured). Used only by store onboarding, which is non-money: it lets the
 * agent-facing onboard_store tool hold the onboard token without ever holding
 * the dashboard token (which also mints ceremony tokens). If `onboardToken` is
 * undefined, this collapses to a plain dashboard-token check. Neither token
 * grants any spending authority — a human signature still gates every mandate. */
export function requireDashboardOrOnboardToken(
  dashboardToken: string,
  onboardToken: string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const dashboard = c.req.header('x-hundi-dashboard-token')
    const onboard = c.req.header('x-hundi-onboard-token')
    const dashboardOk = dashboard === dashboardToken
    const onboardOk = onboardToken !== undefined && onboard === onboardToken
    if (!dashboardOk && !onboardOk) throw new RouteError(401, 'UNAUTHORIZED')
    await next()
  }
}
