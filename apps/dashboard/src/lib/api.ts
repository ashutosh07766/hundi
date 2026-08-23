/**
 * Facilitator HTTP client. Full contract (including the read endpoints this
 * app depends on that don't exist in the facilitator yet) is documented in
 * `apps/dashboard/api-contract.md` — that file is the source of truth the
 * facilitator side implements against, not this comment.
 *
 * Fail-loud: every non-2xx or `{ ok: false }` response throws `ApiError`
 * with the server's error code/detail. Callers render the thrown message;
 * nothing here substitutes placeholder data on failure.
 */

import type { Credential, IntentMandate, SigEnvelope } from '@hundi/core'
import { FACILITATOR_URL } from './config.js'
import type { LedgerEventType } from './narration.js'

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type OkEnvelope<T> = { ok: true } & T
type ErrEnvelope = { ok: false; error: string; detail?: string }

async function request<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${FACILITATOR_URL}${path}`, init)
  } catch (err) {
    throw new ApiError(
      `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new ApiError(`${path} returned a non-JSON response (status ${res.status})`, res.status)
  }
  const body = json as OkEnvelope<T> | ErrEnvelope
  if (!res.ok || body.ok === false) {
    const err = body as ErrEnvelope
    const detail = 'detail' in err && err.detail ? ` — ${err.detail}` : ''
    throw new ApiError(`${path} failed: ${err.error ?? res.statusText}${detail}`, res.status)
  }
  return body as T
}

function postJson<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** POST /ceremony-tokens — dashboard-token-gated mint of a single-use mandate-registration token. */
export async function mintCeremonyToken(dashboardToken: string): Promise<string> {
  const { ceremonyToken } = await postJson<{ ceremonyToken: string }>(
    '/ceremony-tokens',
    {},
    { 'x-hundi-dashboard-token': dashboardToken },
  )
  return ceremonyToken
}

/** POST /mandates — registers the signed intent, binding it to `credential` via the
 * single-use `ceremonyToken`. */
export async function registerMandate(
  intent: IntentMandate,
  credential: Credential,
  ceremonyToken: string,
): Promise<{ mandateId: string; intent_hash_hex: string }> {
  return postJson('/mandates', { intent, credential, ceremonyToken })
}

export type SettlementListItem = {
  id: string
  mandate_id: string
  state: string
  amount_paise: number
  merchant_id: string
  mandate_cart_hash_hex: string
  cart_json: string
  created_at: number
  reject_reason: string | null
}

/** GET /settlements?state=<optional> */
export async function listSettlements(state?: string): Promise<SettlementListItem[]> {
  const qs = state ? `?state=${encodeURIComponent(state)}` : ''
  const { settlements } = await request<{ settlements: SettlementListItem[] }>(`/settlements${qs}`)
  return settlements
}

export type MandateListItem = {
  mandate_id: string
  intent_json: string
  revoked_at: number | null
  created_at: number
}

/** GET /mandates */
export async function listMandates(): Promise<MandateListItem[]> {
  const { mandates } = await request<{ mandates: MandateListItem[] }>('/mandates')
  return mandates
}

export type LedgerEventRow = {
  seq: number
  event_type: LedgerEventType
  settlement_id: string | null
  actor: string
  payload: Record<string, unknown>
  created_at: number
  row_hash: string
}

/** GET /ledger?limit=<n> */
export async function listLedger(limit = 100): Promise<LedgerEventRow[]> {
  const { events } = await request<{ events: LedgerEventRow[] }>(`/ledger?limit=${limit}`)
  return events
}

export type VerifyLedgerResult =
  | { ok: true; head: string; count: number }
  | { ok: false; brokenAtSeq: number }

/** GET /ledger/verify. Unlike every other endpoint, `{ ok: false }` here is a
 * meaningful result (the chain IS broken), not a request failure — so this
 * bypasses `request()`'s "ok:false throws" convention and only treats a
 * non-2xx HTTP status as an actual error. */
export async function verifyLedgerChain(): Promise<VerifyLedgerResult> {
  let res: Response
  try {
    res = await fetch(`${FACILITATOR_URL}/ledger/verify`)
  } catch (err) {
    throw new ApiError(
      `Network error calling /ledger/verify: ${err instanceof Error ? err.message : String(err)}`,
      0,
    )
  }
  if (!res.ok) {
    throw new ApiError(`/ledger/verify failed with status ${res.status}`, res.status)
  }
  return (await res.json()) as VerifyLedgerResult
}

/** POST /approvals */
export async function postApproval(args: {
  settlement_id: string
  mandate_cart_hash_hex: string
  decision: 'approved' | 'rejected'
  sig: SigEnvelope
}): Promise<{ settlement_id: string; state: string }> {
  return postJson('/approvals', args)
}

/** POST /revoke */
export async function postRevoke(args: {
  mandateId: string
  sig: SigEnvelope
}): Promise<{ mandateId: string; alreadyRevoked?: boolean }> {
  return postJson('/revoke', args)
}
