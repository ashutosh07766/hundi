/**
 * Runtime configuration the dashboard needs to talk to the facilitator. The
 * facilitator's CORS allow-list is hardcoded to localhost:5173 (see
 * packages/facilitator/src/app.ts) — this app must run on that exact origin
 * in dev, which `vite.config.ts` pins via `strictPort`.
 */

export const FACILITATOR_URL: string =
  (import.meta.env.VITE_FACILITATOR_URL as string | undefined) ?? 'http://127.0.0.1:8790'

const DASHBOARD_TOKEN_KEY = 'hundi.dashboardToken'

export function getDashboardToken(): string {
  return localStorage.getItem(DASHBOARD_TOKEN_KEY) ?? ''
}

export function setDashboardToken(token: string): void {
  localStorage.setItem(DASHBOARD_TOKEN_KEY, token)
}
