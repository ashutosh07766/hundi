/**
 * Read-path HTTP calls against the facilitator that agent-tools.ts's
 * `HttpBuyerTools` doesn't cover: store/catalog browsing, mandate lookup, and
 * settlement detail. The money path (signing a cart, POST /settlements,
 * polling to a terminal state) stays entirely in `HttpBuyerTools` — this
 * module never signs anything and never calls /settlements itself, so the
 * one place a cart gets built and posted is the one this package shares with
 * every other buyer brain.
 */

import type { IntentMandate } from '@hundi/core'
import type { Product } from '../../../agents/scripted-brain/src/agent-tools.js'

export type StoreListItem = {
  merchant_id: string
  name: string
  product_count: number
  source_url?: string | null
}

export type MandateRecord = {
  mandateId: string
  intent: IntentMandate
  revoked: boolean
  createdAt: number
}

export type SettlementAttempt = {
  state: string
  providerPaymentId: string | null
  receipt: string
  createdAt: number
}

export type LedgerEntry = {
  eventType: string
  actor: string
  createdAt: number
}

export type SettlementDetail = {
  id: string
  mandateId: string
  state: string
  amountPaise: number
  merchantId: string
  cartJson: string
  rejectReason: string | null
  createdAt: number
  attempts: SettlementAttempt[]
  ledger: LedgerEntry[]
}

export type FacilitatorClient = {
  listStores(): Promise<StoreListItem[]>
  getCatalog(merchantId: string): Promise<Product[]>
  listMandates(): Promise<MandateRecord[]>
  getSettlement(settlementId: string): Promise<SettlementDetail | undefined>
}

type Envelope = { ok: boolean; error?: string; detail?: string }

async function parseJson(res: Response, path: string): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new Error(`${path} returned a non-JSON response (status ${res.status})`)
  }
}

function envelopeError(path: string, res: Response, body: Envelope): Error {
  const detail = body.detail ? ` — ${body.detail}` : ''
  return new Error(`${path} failed: ${body.error ?? res.statusText}${detail}`)
}

/** The one implementation this package ships. Every call goes to `facilitatorUrl` —
 * this class never learns of a store's own URL, matching stores.ts's design: the
 * facilitator is the single origin every catalog fetch is keyed through. */
export function createFacilitatorClient(facilitatorUrl: string): FacilitatorClient {
  const base = facilitatorUrl.replace(/\/$/, '')

  async function getEnvelope<T extends Envelope>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`)
    const body = (await parseJson(res, path)) as T
    if (!res.ok || body.ok === false) throw envelopeError(path, res, body)
    return body
  }

  return {
    async listStores() {
      const { stores } = await getEnvelope<{ ok: true; stores: StoreListItem[] }>('/stores')
      return stores
    },

    // GET /catalog/:merchant_id is the one facilitator read route that doesn't
    // wrap its success body in { ok: true, ... } — it returns the product array
    // verbatim (see routes/stores.ts) — so this can't reuse getEnvelope.
    async getCatalog(merchantId) {
      const path = `/catalog/${encodeURIComponent(merchantId)}`
      const res = await fetch(`${base}${path}`)
      const body = await parseJson(res, path)
      if (!res.ok) throw envelopeError(path, res, body as Envelope)
      return body as Product[]
    },

    async listMandates() {
      type Row = {
        mandate_id: string
        intent_json: string
        revoked_at: number | null
        created_at: number
      }
      const { mandates } = await getEnvelope<{ ok: true; mandates: Row[] }>('/mandates')
      return mandates.map((row) => ({
        mandateId: row.mandate_id,
        intent: JSON.parse(row.intent_json) as IntentMandate,
        revoked: row.revoked_at !== null,
        createdAt: row.created_at,
      }))
    },

    async getSettlement(settlementId) {
      const path = `/settlements/${encodeURIComponent(settlementId)}`
      const res = await fetch(`${base}${path}`)
      if (res.status === 404) return undefined
      const body = (await parseJson(res, path)) as Envelope & {
        settlement?: {
          id: string
          mandate_id: string
          state: string
          amount_paise: number
          merchant_id: string
          cart_json: string
          reject_reason: string | null
          created_at: number
        }
        attempts?: {
          state: string
          provider_payment_id: string | null
          receipt: string
          created_at: number
        }[]
        ledger?: { event_type: string; actor: string; created_at: number }[]
      }
      if (!res.ok || body.ok === false || !body.settlement) throw envelopeError(path, res, body)
      return {
        id: body.settlement.id,
        mandateId: body.settlement.mandate_id,
        state: body.settlement.state,
        amountPaise: body.settlement.amount_paise,
        merchantId: body.settlement.merchant_id,
        cartJson: body.settlement.cart_json,
        rejectReason: body.settlement.reject_reason,
        createdAt: body.settlement.created_at,
        attempts: (body.attempts ?? []).map((a) => ({
          state: a.state,
          providerPaymentId: a.provider_payment_id,
          receipt: a.receipt,
          createdAt: a.created_at,
        })),
        ledger: (body.ledger ?? []).map((l) => ({
          eventType: l.event_type,
          actor: l.actor,
          createdAt: l.created_at,
        })),
      }
    },
  }
}
