/**
 * Builds the DB-backed `VerifyCtx` that `verifyChain` (core) needs, and
 * computes the mandate-cart hash that identifies a specific intent+cart
 * pairing. Shared by /verify (stateless dry-run) and /settlements
 * (persisted) so both routes resolve "is this mandate known/revoked/does
 * this cart dup an existing settlement" identically.
 */

import type { CartMandate, IntentMandate, VerifyCtx } from '@hundi/core'
import { canonicalJson, cartSigningBytes, intentSigningBytes, sha256Hex } from '@hundi/core'
import type Database from 'better-sqlite3'
import type { FeedProduct } from './feed-product.js'
import {
  credentialFromRow,
  getCapturedSpend,
  getCapturedSpendAtMerchant,
  getMandateRow,
} from './mandate-repo.js'
import { getStoreCatalog } from './store-catalog-repo.js'

/**
 * Content-addressed identifier for one intent+cart pairing. Pure — computed
 * from the signing bytes only, independent of whether the signatures
 * actually verify, so it can be used to check for duplicate settlement rows
 * before (or instead of) running full signature verification.
 */
export function computeMandateCartHash(intent: IntentMandate, cart: CartMandate): string {
  const intentHashHex = sha256Hex(intentSigningBytes(intent))
  const cartHashHex = sha256Hex(cartSigningBytes(cart))
  return sha256Hex(canonicalJson({ intent_hash: intentHashHex, cart_hash: cartHashHex }))
}

/** Resolves the per-sku searchable text (title + brand + description, lowercased) the
 * core `verifyChain` goal-binding check needs — only when the intent actually carries
 * `goal_keywords`, since most mandates don't and shouldn't pay for the catalog read.
 * A sku absent from the merchant's catalog gets no entry, which is what makes
 * `verifyChain` fail closed on it (see core/verify.ts). */
function resolveItemGoalTexts(
  db: Database.Database,
  intent: IntentMandate,
  cart: CartMandate,
): Record<string, string> | undefined {
  if (!intent.goal_keywords || intent.goal_keywords.length === 0) return undefined

  const catalogRow = getStoreCatalog(db, cart.merchant_id)
  const products = catalogRow ? (JSON.parse(catalogRow.catalog_json) as FeedProduct[]) : []
  const bySku = new Map(products.map((p) => [p.id, p]))

  const itemGoalTexts: Record<string, string> = {}
  for (const item of cart.items) {
    const product = bySku.get(item.sku)
    if (product) {
      itemGoalTexts[item.sku] =
        `${product.title} ${product.brand} ${product.description}`.toLowerCase()
    }
  }
  return itemGoalTexts
}

export type BuildVerifyCtxOptions = {
  /** Excludes this settlement id from the duplicate-cart lookup — used by /settlements,
   * which has already inserted its own (not-yet-terminal) row under the same hash. */
  excludeSettlementId?: string
}

export type ResolvedVerifyContext = {
  ctx: VerifyCtx
  mandateCartHashHex: string
}

export function buildVerifyCtx(
  db: Database.Database,
  intent: IntentMandate,
  cart: CartMandate,
  now: number,
  opts: BuildVerifyCtxOptions = {},
): ResolvedVerifyContext {
  const mandateRow = getMandateRow(db, intent.mandateId)
  const credential = mandateRow ? credentialFromRow(mandateRow) : undefined
  const revoked = mandateRow?.revoked_at != null

  // Cumulative wallet: the ceiling caps total captured spend across this mandate's
  // lifetime, not one purchase. verifyChain adds the current cart to this and
  // rejects AMOUNT_EXCEEDS_CEILING if the sum exceeds the ceiling. The current
  // settlement is still non-terminal here (created/verifying/settling), so it
  // never counts toward its own spent-so-far, and one_live_settlement_per_mandate
  // (schema.sql) keeps spends serialized so this can't be raced by a concurrent
  // capture. Shared with GET /mandates via getCapturedSpend so the two agree.
  const spentPaise = getCapturedSpend(db, intent.mandateId)

  // Per-merchant spend is only needed when the intent sets a sub-ceiling for this
  // cart's merchant — skip the query otherwise.
  const merchantSpentPaise =
    intent.per_merchant_ceiling_paise?.[cart.merchant_id] !== undefined
      ? getCapturedSpendAtMerchant(db, intent.mandateId, cart.merchant_id)
      : undefined

  const itemGoalTexts = resolveItemGoalTexts(db, intent, cart)

  const mandateCartHashHex = computeMandateCartHash(intent, cart)

  const dupRow = opts.excludeSettlementId
    ? db
        .prepare(
          `SELECT 1 FROM settlements
           WHERE mandate_cart_hash_hex = ? AND id != ? AND state NOT IN ('failed','rejected','abandoned')
           LIMIT 1`,
        )
        .get(mandateCartHashHex, opts.excludeSettlementId)
    : db
        .prepare(
          `SELECT 1 FROM settlements
           WHERE mandate_cart_hash_hex = ? AND state NOT IN ('failed','rejected','abandoned')
           LIMIT 1`,
        )
        .get(mandateCartHashHex)
  const duplicateCart = dupRow !== undefined

  const merchantRow = db
    .prepare('SELECT config_json FROM merchants WHERE merchant_id = ?')
    .get(cart.merchant_id) as { config_json: string } | undefined
  let catalogPrices: Record<string, number> | undefined
  if (merchantRow) {
    const config = JSON.parse(merchantRow.config_json) as { catalogPrices?: Record<string, number> }
    if (config.catalogPrices) catalogPrices = config.catalogPrices
  }

  const ctx: VerifyCtx = {
    now,
    revoked,
    spentPaise,
    duplicateCart,
    ...(merchantSpentPaise !== undefined ? { merchantSpentPaise } : {}),
    ...(credential ? { credential } : {}),
    ...(catalogPrices ? { catalogPrices } : {}),
    ...(itemGoalTexts ? { itemGoalTexts } : {}),
  }

  return { ctx, mandateCartHashHex }
}
