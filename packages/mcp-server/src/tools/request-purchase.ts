/**
 * request_purchase — the only money-adjacent tool in this server. It builds and
 * signs a cart with this process's own agent key and hands it to the facilitator's
 * POST /settlements; every deterministic mandate check (ceiling, threshold,
 * merchant scope, expiry, revocation, price match) runs there, not here. This
 * handler never decides whether a purchase is allowed — it only reports what the
 * facilitator decided, and never auto-approves a `pending_approval` result. A human
 * approving in the dashboard is the only path a pending purchase can complete.
 *
 * Reuses agent-tools.ts's `buildCartDraft` (so line-item/total math lives in one
 * place, computed from catalog data, never from tool input) and `BuyerTools.
 * requestPayment` (so the sign → POST /settlements → poll sequence is byte-for-byte
 * the same code path every other buyer brain in this repo drives).
 */

import { canonicalJson, sha256Hex } from '@hundi/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  BuyerTools,
  Product,
  ProductVariant,
} from '../../../../agents/scripted-brain/src/agent-tools.js'
import { buildCartDraft } from '../../../../agents/scripted-brain/src/agent-tools.js'
import type { AgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import type { FacilitatorClient, MandateRecord } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

function findAuthorizedMandate(
  mandates: MandateRecord[],
  mandateId: string,
  agentPublicKeyHex: string,
  merchantId: string,
): MandateRecord {
  const record = mandates.find((m) => m.mandateId === mandateId)
  if (!record) {
    throw new Error(
      `No mandate found with id "${mandateId}". Call get_agent_identity to see mandates that ` +
        'currently authorize this agent.',
    )
  }
  if (record.intent.agent_pubkey_hex !== agentPublicKeyHex) {
    throw new Error(
      `Mandate "${mandateId}" does not authorize this agent's key — it authorizes a different ` +
        'agent. This server can only spend under a mandate issued to its own public key (see ' +
        'get_agent_identity).',
    )
  }
  if (record.revoked) {
    throw new Error(`Mandate "${mandateId}" has been revoked and can no longer be used.`)
  }
  if (!record.intent.merchants.includes(merchantId)) {
    throw new Error(
      `Mandate "${mandateId}" does not authorize purchases from merchant "${merchantId}". ` +
        `Authorized merchants: ${record.intent.merchants.join(', ')}.`,
    )
  }
  return record
}

function findProduct(products: Product[], sku: string, merchantId: string): Product {
  const product = products.find((p) => p.id === sku)
  if (!product) {
    throw new Error(
      `No product with sku "${sku}" found in merchant "${merchantId}"'s catalog. Call ` +
        'search_products to see what is available.',
    )
  }
  return product
}

function describeVariants(variants: ProductVariant[]): string {
  return variants
    .map(
      (v) =>
        `${v.label} (${formatRupees(v.price_paise)}${v.available ? '' : ', out of stock'}, variant_id "${v.variant_id}")`,
    )
    .join('; ')
}

/** Does `variant` carry every requested option value? Each requested value must
 * equal one of the variant's `option_values` (case-insensitive), matched to a
 * DISTINCT position — so "Leather Black" + "11UK" resolves against a variant
 * whose axes are ["Leather Black", "11UK"] regardless of the order they were
 * passed in, and never false-matches on a substring or a shared position. This
 * is the fix for order-sensitive label concatenation: size and color are matched
 * against their own axes, not glued into one string and substring-searched. */
function variantHasAllValues(variant: ProductVariant, values: string[]): boolean {
  const remaining = variant.option_values.map((v) => v.trim().toLowerCase())
  for (const value of values) {
    const idx = remaining.indexOf(value.trim().toLowerCase())
    if (idx === -1) return false
    remaining.splice(idx, 1)
  }
  return true
}

/** Free-text fallback for a single `variant` string like "11 / Black" — exact
 * label first, then substring on label or any option value. Only used when the
 * caller passes `variant` rather than structured `size`/`color`. */
function findVariantByText(variants: ProductVariant[], needle: string): ProductVariant | undefined {
  const n = needle.trim().toLowerCase()
  const exact = variants.find(
    (v) => v.label.toLowerCase() === n || v.option_values.some((val) => val.toLowerCase() === n),
  )
  if (exact) return exact
  return variants.find(
    (v) =>
      v.label.toLowerCase().includes(n) ||
      v.option_values.some((val) => val.toLowerCase().includes(n)),
  )
}

type VariantResolution = { ok: true; variant?: ProductVariant } | { ok: false; error: string }

/**
 * Resolves the shopper's requested size/color against a product's real variant
 * list. Fails loud on a mismatch or an ambiguous request — an error listing
 * what's actually available — rather than silently buying the base SKU at the
 * wrong size, per this tool's own contract (see the tool description). No
 * size/color/variant/variant_id requested at all is a distinct, valid case: the
 * product is bought with no variant recorded, exactly as it always has been.
 */
function resolveVariant(
  product: Product,
  args: {
    size?: string | undefined
    color?: string | undefined
    variant?: string | undefined
    variant_id?: string | undefined
  },
): VariantResolution {
  const exactValues = [args.size, args.color].filter((v): v is string => !!v && v.trim().length > 0)
  const requestedSomething =
    args.variant_id !== undefined ||
    exactValues.length > 0 ||
    (args.variant !== undefined && args.variant.trim().length > 0)

  if (!product.variants || product.variants.length === 0) {
    if (!requestedSomething) return { ok: true }
    return {
      ok: false,
      error:
        `"${product.title}" has no size/color choices — it is a single listing. Call ` +
        'request_purchase again for this sku without size/color/variant/variant_id.',
    }
  }

  if (!requestedSomething) return { ok: true }

  if (args.variant_id) {
    const match = product.variants.find((v) => v.variant_id === args.variant_id)
    if (match) return { ok: true, variant: match }
    return {
      ok: false,
      error:
        `variant_id "${args.variant_id}" does not exist on "${product.title}". Available: ` +
        `${describeVariants(product.variants)}.`,
    }
  }

  // Structured size/color: match each value against its own axis, order-insensitively.
  if (exactValues.length > 0) {
    const matches = product.variants.filter((v) => variantHasAllValues(v, exactValues))
    const only = matches[0]
    if (matches.length === 1 && only) return { ok: true, variant: only }
    if (matches.length > 1) {
      return {
        ok: false,
        error:
          `"${exactValues.join(' + ')}" matches ${matches.length} variants on "${product.title}" ` +
          `— specify all axes (e.g. both size and color). Matching: ${describeVariants(matches)}.`,
      }
    }
    return {
      ok: false,
      error:
        `No variant on "${product.title}" has ${exactValues.map((v) => `"${v}"`).join(' + ')}. ` +
        `Available: ${describeVariants(product.variants)}.`,
    }
  }

  // Only a free-text `variant` string was given.
  const match = args.variant ? findVariantByText(product.variants, args.variant) : undefined
  if (match) return { ok: true, variant: match }
  return {
    ok: false,
    error:
      `No "${args.variant}" option on "${product.title}". Available: ` +
      `${describeVariants(product.variants)}.`,
  }
}

export function registerRequestPurchaseTool(
  server: McpServer,
  deps: {
    agent: AgentKeypair
    facilitatorClient: FacilitatorClient
    buyerTools: Pick<BuyerTools, 'requestPayment'>
  },
): void {
  server.registerTool(
    'request_purchase',
    {
      title: 'Request purchase',
      description:
        'Attempts to buy a product under a mandate the human has already authorized. Price and ' +
        "total are always read fresh from the merchant's catalog — never from your input — so this " +
        'cannot be tricked into charging a different amount than what the store actually lists. ' +
        "Every purchase passes the facilitator's deterministic mandate checks (spending ceiling, " +
        'merchant scope, expiry, revocation, price match) before any money moves. Three outcomes: ' +
        '"captured" (paid), "pending_approval" (over the mandate\'s auto-approval threshold — a ' +
        "human must approve it in the Hundi dashboard's Pending approvals tab; this tool never " +
        'auto-approves and never re-polls for you), or "rejected"/"failed" (the facilitator\'s exact ' +
        'reason is included, e.g. AMOUNT_EXCEEDS_CEILING). If the product has size/color choices ' +
        '(see `variants` on its search_products result) and you pass `size`/`color`/`variant`/' +
        '`variant_id` that does not match one of them, this tool returns an error listing the real ' +
        'options and buys nothing — it never silently substitutes the base product or a different size.',
      inputSchema: {
        merchant_id: z
          .string()
          .min(1)
          .describe('The merchant_id from list_stores/search_products.'),
        sku: z.string().min(1).describe('The product sku from search_products.'),
        qty: z.number().int().positive().default(1).describe('Quantity to buy. Defaults to 1.'),
        mandate_id: z
          .string()
          .min(1)
          .describe(
            "The mandate authorizing this purchase — from get_agent_identity's authorizing_mandates.",
          ),
        size: z
          .string()
          .optional()
          .describe('Requested size, if the product has size choices (see `options`/`variants`).'),
        color: z
          .string()
          .optional()
          .describe(
            'Requested color, if the product has color choices (see `options`/`variants`).',
          ),
        variant: z
          .string()
          .optional()
          .describe(
            'Free-text variant description (e.g. "11 / Black") when size/color alone is ambiguous.',
          ),
        variant_id: z
          .string()
          .optional()
          .describe(
            'The exact variant_id from search_products, when known — takes precedence over ' +
              'size/color/variant.',
          ),
        max_price_paise: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Optional agent-side upper bound (in paise) on the cart total — pass the exact figure ' +
              'you quoted the user. If the fresh catalog total exceeds it, this tool refuses before ' +
              'signing. Note this is a guard on purchases made through this tool, not a facilitator ' +
              'rule; the facilitator separately rejects any price that disagrees with its catalog.',
          ),
        idempotency_token: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Retry-safety token. OMIT for a new purchase — including buying the same item again ' +
              '(each omitted call settles independently). Only when RETRYING one purchase after an ' +
              'ambiguous failure (a timeout, a lost response), call again with the SAME token you ' +
              'would generate once for that attempt: the facilitator then replays the first result ' +
              'instead of charging twice. Reusing a token for a genuinely new purchase would make ' +
              'that purchase silently replay the earlier one, so never share a token across ' +
              'distinct purchases.',
          ),
      },
    },
    async ({
      merchant_id,
      sku,
      qty,
      mandate_id,
      size,
      color,
      variant,
      variant_id,
      max_price_paise,
      idempotency_token,
    }) => {
      const mandates = await deps.facilitatorClient.listMandates()
      const record = findAuthorizedMandate(
        mandates,
        mandate_id,
        deps.agent.publicKeyHex,
        merchant_id,
      )

      const products = await deps.facilitatorClient.getCatalog(merchant_id)
      const product = findProduct(products, sku, merchant_id)

      const resolution = resolveVariant(product, { size, color, variant, variant_id })
      if (!resolution.ok) {
        return jsonResult({
          state: 'rejected',
          reason: 'VARIANT_NOT_FOUND',
          message: resolution.error,
        })
      }

      // Retry identity is the CALLER's to declare, not something inferred from
      // the purchase parameters — parameters can't tell "retry of one purchase"
      // from "a second, genuinely-distinct purchase of the same item" (which a
      // cumulative wallet exists to allow). When the agent passes an
      // idempotency_token (reused only to retry one attempt), both the cart id and
      // the Idempotency-Key derive from it — stable across the retry AND
      // price-independent, so a price move between the purchase and its retry
      // still dedups. Absent, both are random per call: a new purchase every time,
      // so an identical repeat buy settles for real instead of replaying a fake
      // "captured".
      const cartId = idempotency_token
        ? sha256Hex(canonicalJson({ purchase_cart: idempotency_token }))
        : undefined
      const idempotencyKey = idempotency_token
        ? sha256Hex(canonicalJson({ purchase_idem: idempotency_token }))
        : undefined

      const cart = buildCartDraft(
        [
          {
            product,
            qty,
            ...(resolution.variant ? { variantId: resolution.variant.variant_id } : {}),
          },
        ],
        cartId,
      )

      // Client-side price bound (§ max_price_paise): an agent-side guard, not a
      // system control — the facilitator has no per-purchase price ceiling (only
      // PRICE_MISMATCH against its catalog and the cumulative mandate ceiling), so
      // this only binds purchases made through this tool. It lets the agent pin
      // the spend to the figure it quoted the user; a different caller would not
      // be bound by it.
      if (max_price_paise !== undefined && cart.total_paise > max_price_paise) {
        return jsonResult({
          state: 'rejected',
          reason: 'MAX_PRICE_EXCEEDED',
          message:
            `The current total for ${qty} x "${product.title}" is ${formatRupees(cart.total_paise)}, ` +
            `above your max of ${formatRupees(max_price_paise)}. Nothing was charged. Re-confirm ` +
            'the new price with the user before retrying.',
        })
      }

      const result = await deps.buyerTools.requestPayment({
        intent: record.intent,
        cart,
        agent: deps.agent,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      })

      if (result.state === 'captured') {
        const settlement = await deps.facilitatorClient.getSettlement(result.settlement_id)
        const paymentId =
          settlement?.attempts.find((a) => a.state === 'captured')?.providerPaymentId ?? null
        const variantSuffix = resolution.variant ? ` (${resolution.variant.label})` : ''
        return jsonResult({
          state: result.state,
          settlement_id: result.settlement_id,
          payment_id: paymentId,
          amount_paise: cart.total_paise,
          ...(resolution.variant
            ? { variant_id: resolution.variant.variant_id, variant_label: resolution.variant.label }
            : {}),
          message: `Captured: ${qty} x "${product.title}"${variantSuffix} for ${formatRupees(cart.total_paise)}.`,
        })
      }

      if (result.state === 'pending_approval') {
        return jsonResult({
          state: result.state,
          settlement_id: result.settlement_id,
          amount_paise: cart.total_paise,
          message:
            `This ${formatRupees(cart.total_paise)} purchase exceeds the mandate's auto-approval ` +
            'threshold. A human must approve it in the Hundi dashboard — Pending approvals tab — ' +
            'before it will be charged. This tool will not check back on its own; call get_order ' +
            'with this settlement_id later to see whether it was approved.',
        })
      }

      // 'rejected'/'failed'/'abandoned' are terminal — the facilitator's own reason (e.g.
      // AMOUNT_EXCEEDS_CEILING) is included verbatim. Any other value here means polling
      // gave up before a real settlement (a headless-browser checkout can run long) reached
      // a terminal state — not a failure, just still in flight; get_order picks up from where
      // this left off once it finishes.
      const stillInFlight = !['rejected', 'failed', 'abandoned'].includes(result.state)
      return jsonResult({
        state: result.state,
        settlement_id: result.settlement_id || null,
        reason: result.reason ?? null,
        message: stillInFlight
          ? `Still processing (${result.state}). Call get_order with this settlement_id in a ` +
            'few seconds to check whether it reached a final state.'
          : `Not completed (${result.state})${result.reason ? `: ${result.reason}` : ''}.`,
      })
    },
  )
}
