/**
 * Read-path HTTP calls against the facilitator that agent-tools.ts's
 * `HttpBuyerTools` doesn't cover: store/catalog browsing, mandate lookup, and
 * settlement detail. The money path (signing a cart, POST /settlements,
 * polling to a terminal state) stays entirely in `HttpBuyerTools` — this
 * module never signs anything and never calls /settlements itself, so the
 * one place a cart gets built and posted is the one this package shares with
 * every other buyer brain.
 */

import type { IntentMandate, MandateWalletState } from '@hundi/core'
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
  /** Cumulative wallet accounting from the facilitator — the source of truth for
   * "how much is left", so a client never computes a remaining balance by
   * subtraction (which silently drifts the moment the spend model changes). */
  spentPaise: number
  remainingPaise: number
  state: MandateWalletState
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

export type ProposeMandateArgs = {
  merchantId: string
  goal: string
  ceilingPaise: number
  approvalThresholdPaise: number
  agentPubkeyHex: string
  /** Optional per-merchant sub-ceilings (paise), mirroring IntentMandate's own
   * optional policy fields (see @hundi/core's mandate.ts). Omit entirely — never
   * pass an empty object — when the caller didn't ask for a split. */
  perMerchantCeilingPaise?: Record<string, number> | undefined
  cumulativeApprovalThresholdPaise?: number | undefined
  /** Optional purpose restriction, mirroring IntentMandate's own `goal_keywords`
   * (see @hundi/core's mandate.ts). Omit entirely — never pass an empty array —
   * when the caller didn't ask to scope the mandate by keyword. */
  goalKeywords?: string[] | undefined
}

export type ProposeMandateResult = {
  proposalId: string
  approveUrl: string
}

/** A row from GET /settlements — the list view, without the per-attempt/ledger
 * detail that getSettlement carries. `cartJson` is the stored signed cart, parsed
 * by callers that want line items. */
export type SettlementSummary = {
  id: string
  mandateId: string
  state: string
  amountPaise: number
  merchantId: string
  cartJson: string
  createdAt: number
  rejectReason: string | null
}

export type SearchCatalogArgs = {
  query: string
  maxPricePaise?: number
  merchantId?: string
  inStockOnly?: boolean
  limit?: number
}

export type OnboardStoreResult = {
  merchantId: string
  name: string
  productCount: number
  sample: string[]
  warnings: string[]
}

export type FacilitatorClient = {
  listStores(): Promise<StoreListItem[]>
  /** POST /stores/onboard — scans a public storefront's catalog and stores it so
   * the store becomes shoppable. Gated by the narrow onboard token (never the
   * dashboard token), so this grants no spending authority: onboarding only makes
   * a catalog available; a human-signed mandate still gates every purchase. */
  onboardStore(url: string): Promise<OnboardStoreResult>
  getCatalog(merchantId: string): Promise<Product[]>
  /** GET /catalog/search — the one catalog read that spans every onboarded store instead
   * of a single merchant_id. Results are ranked server-side (see the facilitator's
   * catalog-search.ts); this client does no re-sorting or re-filtering of its own. */
  searchCatalog(args: SearchCatalogArgs): Promise<Product[]>
  listMandates(): Promise<MandateRecord[]>
  listSettlements(): Promise<SettlementSummary[]>
  getSettlement(settlementId: string): Promise<SettlementDetail | undefined>
  /** POST /mandates/propose — stages an INERT draft, never a spendable mandate. Nothing
   * this client signs; the facilitator route itself requires no auth token because a
   * proposal binds no credential (see packages/facilitator/src/routes/mandate-proposals.ts). */
  proposeMandate(args: ProposeMandateArgs): Promise<ProposeMandateResult>
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
export function createFacilitatorClient(
  facilitatorUrl: string,
  onboardToken?: string,
): FacilitatorClient {
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

    async onboardStore(url) {
      if (!onboardToken) {
        throw new Error(
          'Store onboarding is not configured on this server (no onboard token). Ask the operator ' +
            'to onboard the store from the Hundi dashboard instead.',
        )
      }
      const path = '/stores/onboard'
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hundi-onboard-token': onboardToken },
        body: JSON.stringify({ url }),
      })
      const body = (await parseJson(res, path)) as Envelope & {
        merchant_id?: string
        name?: string
        product_count?: number
        sample?: string[]
        warnings?: string[]
      }
      if (!res.ok || body.ok === false || !body.merchant_id) throw envelopeError(path, res, body)
      return {
        merchantId: body.merchant_id,
        name: body.name ?? body.merchant_id,
        productCount: body.product_count ?? 0,
        sample: body.sample ?? [],
        warnings: body.warnings ?? [],
      }
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

    async searchCatalog(args) {
      const params = new URLSearchParams({ q: args.query })
      if (args.maxPricePaise !== undefined) {
        params.set('max_price_paise', String(args.maxPricePaise))
      }
      if (args.merchantId !== undefined) params.set('merchant_id', args.merchantId)
      if (args.inStockOnly) params.set('in_stock', 'true')
      if (args.limit !== undefined) params.set('limit', String(args.limit))

      const { results } = await getEnvelope<{ ok: true; results: Product[] }>(
        `/catalog/search?${params.toString()}`,
      )
      return results
    },

    async listMandates() {
      type Row = {
        mandate_id: string
        intent_json: string
        revoked_at: number | null
        created_at: number
        spent_paise: number | null
        remaining_paise: number | null
        state: MandateWalletState
      }
      const { mandates } = await getEnvelope<{ ok: true; mandates: Row[] }>('/mandates')
      return mandates.map((row) => ({
        mandateId: row.mandate_id,
        intent: JSON.parse(row.intent_json) as IntentMandate,
        revoked: row.revoked_at !== null,
        createdAt: row.created_at,
        // A state:'error' row (unparseable stored intent) carries null accounting;
        // surface 0 rather than propagate null — the 'error' state is the signal.
        spentPaise: row.spent_paise ?? 0,
        remainingPaise: row.remaining_paise ?? 0,
        state: row.state,
      }))
    },

    async proposeMandate(args) {
      const path = '/mandates/propose'
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchant_id: args.merchantId,
          goal: args.goal,
          ceiling_paise: args.ceilingPaise,
          approval_threshold_paise: args.approvalThresholdPaise,
          agent_pubkey_hex: args.agentPubkeyHex,
          ...(args.perMerchantCeilingPaise
            ? { per_merchant_ceiling_paise: args.perMerchantCeilingPaise }
            : {}),
          ...(args.cumulativeApprovalThresholdPaise !== undefined
            ? { cumulative_approval_threshold_paise: args.cumulativeApprovalThresholdPaise }
            : {}),
          ...(args.goalKeywords ? { goal_keywords: args.goalKeywords } : {}),
        }),
      })
      const body = (await parseJson(res, path)) as Envelope & {
        proposal_id?: string
        approve_url?: string
      }
      if (!res.ok || body.ok === false || !body.proposal_id || !body.approve_url) {
        throw envelopeError(path, res, body)
      }
      return { proposalId: body.proposal_id, approveUrl: body.approve_url }
    },

    async listSettlements() {
      type Row = {
        id: string
        mandate_id: string
        state: string
        amount_paise: number
        merchant_id: string
        cart_json: string
        created_at: number
        reject_reason: string | null
      }
      const { settlements } = await getEnvelope<{ ok: true; settlements: Row[] }>('/settlements')
      return settlements.map((row) => ({
        id: row.id,
        mandateId: row.mandate_id,
        state: row.state,
        amountPaise: row.amount_paise,
        merchantId: row.merchant_id,
        cartJson: row.cart_json,
        createdAt: row.created_at,
        rejectReason: row.reject_reason,
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
