// Shared helpers for the Razorpay test-mode rail-matrix spikes.
//
// All Razorpay calls in this directory go through `rzpFetch` so the auth
// header, timeout, and non-JSON-body handling stay in one place. Every
// script logs one JSON line per meaningful step via `logStep` so a run can
// be replayed/diffed from stdout alone.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RAZORPAY_V1_BASE = 'https://api.razorpay.com/v1'

const REQUEST_TIMEOUT_MS = 30_000

/**
 * Populates process.env from the nearest .env file, walking up from this
 * module's directory. Existing process.env values (e.g. set via
 * `--env-file`) are never overwritten. Silent no-op if no .env is found —
 * callers that require a var must check for it explicitly via `requireEnv`.
 */
export function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) {
      applyEnvFile(readFileSync(candidate, 'utf8'))
      return
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

function applyEnvFile(raw: string): void {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (isQuoted) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`missing required env var: ${name}`)
  }
  return value
}

/** One structured JSON line per step. Never pass secrets into `data`. */
export function logStep(step: string, ok: boolean, data: unknown): void {
  console.log(JSON.stringify({ step, ok, data, ts: new Date().toISOString() }))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function freshReceipt(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

export interface RzpResult<T = unknown> {
  ok: boolean
  status: number
  /** Parsed JSON body, or `{ raw: <text> }` when the response wasn't valid JSON. */
  body: T | { raw: string }
}

/**
 * POSTs/GETs against the Razorpay REST API with Basic auth built from
 * RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. Never logs the secret — only the
 * base64'd header value ever leaves this function, and only over the wire.
 * Every call carries a 30s timeout so a hung probe fails loud instead of
 * hanging the matrix run.
 */
export async function rzpFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  base: string = RAZORPAY_V1_BASE,
): Promise<RzpResult<T>> {
  const keyId = requireEnv('RAZORPAY_KEY_ID')
  const keySecret = requireEnv('RAZORPAY_KEY_SECRET')
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64')

  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${auth}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, body: { raw: `fetch_failed: ${message}` } as { raw: string } }
  }

  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  return { ok: res.ok, status: res.status, body: body as T }
}
