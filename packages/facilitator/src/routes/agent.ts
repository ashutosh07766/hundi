/**
 * POST /agent/select — advises which catalog product best matches a mandate's
 * goal, so apps/dashboard's "Run test purchase" button can buy what the
 * merchant actually asked for instead of always grabbing the cheapest
 * in-stock item. This route is advisory only: it never builds, signs, or
 * submits a cart. The agent key stays in the dashboard tab, which builds and
 * signs the cart itself from the `chosen_sku` this endpoint returns — this
 * process never sees the agent's private key and could be deleted without
 * removing any capability the dashboard doesn't already have via the client-
 * side cheapest-pick fallback.
 *
 * The LLM call happens here, server-side, for two reasons: the free-tier
 * OpenAI-compatible endpoints this brain targets (Groq, Gemini, ...) block
 * direct browser calls via CORS, and the API key must never reach a page a
 * store visitor's browser can inspect.
 *
 * `env.LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` are optional (see env.ts) — when
 * any is missing, this route degrades visibly to the same cheapest-in-stock-
 * under-ceiling rule apps/dashboard's client-side `pickProduct` already uses,
 * reporting `via:'cheapest'` rather than silently pretending an LLM chose.
 */

import { zValidator } from '@hono/zod-validator'
import type { Hono } from 'hono'
import {
  buildDefaultChatClient,
  chooseProduct as defaultChooseProduct,
} from '../../../../agents/llm-brain/src/index.js'
import type { AppDeps } from '../app.js'
import type { FeedProduct } from '../feed-product.js'
import { buildPoisonProduct } from '../feed-product.js'
import { requireHeaderToken } from '../middleware.js'
import { agentSelectBodySchema } from '../schemas.js'
import { getStoreCatalog } from '../store-catalog-repo.js'

/** Same cheapest-in-stock-under-ceiling rule as llm-brain's `fallbackPick` and
 * apps/dashboard's `pickProduct` — the rule every buyer path converges on
 * when there's no reasoned pick to make (here: no LLM configured at all). */
function cheapestInStock(products: FeedProduct[], ceilingPaise: number): FeedProduct | undefined {
  return products
    .filter((p) => p.availability.status === 'in_stock' && p.price_paise <= ceilingPaise)
    .sort((a, b) => a.price_paise - b.price_paise)[0]
}

type SelectSuccess = {
  ok: true
  chosen_sku: string
  title: string
  price_paise: number
  merchant_id: string
  reason: string
  via: 'llm' | 'fallback' | 'cheapest'
  /** Present only when the LLM path resolved a specific variant (see
   * chooseProduct's `chosen_variant_id`). The cheapest-fallback path never sets
   * this — it has no size/color concept to reason about. */
  chosen_variant_id?: string
  variant_label?: string
}

function pickResponse(
  pick: FeedProduct,
  reason: string,
  via: SelectSuccess['via'],
  variant?: { chosen_variant_id: string; variant_label?: string | undefined },
): SelectSuccess {
  return {
    ok: true,
    chosen_sku: pick.id,
    title: pick.title,
    price_paise: pick.price_paise,
    merchant_id: pick.merchant_id,
    reason,
    via,
    ...(variant ? { chosen_variant_id: variant.chosen_variant_id } : {}),
    ...(variant?.variant_label ? { variant_label: variant.variant_label } : {}),
  }
}

export function registerAgentRoutes(app: Hono, deps: AppDeps): void {
  const { db, env } = deps
  const chooseProduct = deps.chooseProduct ?? defaultChooseProduct

  app.post(
    '/agent/select',
    requireHeaderToken('x-hundi-dashboard-token', env.DASHBOARD_TOKEN),
    zValidator('json', agentSelectBodySchema),
    async (c) => {
      const { merchant_id, goal, ceiling_paise, poisoned } = c.req.valid('json')

      const row = getStoreCatalog(db, merchant_id)
      const catalog: FeedProduct[] = row ? JSON.parse(row.catalog_json) : []
      // Mirrors GET /catalog/:merchant_id?poisoned=1 (routes/stores.ts) exactly, so a
      // poisoned test-purchase sees the same attacker listing either path evaluates.
      const candidates = poisoned ? [...catalog, buildPoisonProduct(catalog)] : catalog

      if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) {
        const cheapest = cheapestInStock(candidates, ceiling_paise)
        if (!cheapest) return c.json({ ok: false, error: 'NO_AFFORDABLE_PRODUCT' }, 200)
        return c.json(
          pickResponse(cheapest, 'LLM not configured; chose cheapest in budget', 'cheapest'),
          200,
        )
      }

      const chat = buildDefaultChatClient({
        baseUrl: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
      })
      const choice = await chooseProduct({
        candidates,
        goal: { query: goal, ceiling_paise },
        chat,
      })
      if (!choice.product) return c.json({ ok: false, error: 'NO_AFFORDABLE_PRODUCT' }, 200)

      const reason = choice.overridden
        ? `LLM pick unavailable (${choice.override_reason}); chose cheapest in-stock match under budget`
        : (choice.reason ?? 'LLM selection')
      return c.json(
        pickResponse(
          choice.product,
          reason,
          choice.overridden ? 'fallback' : 'llm',
          choice.chosen_variant_id
            ? { chosen_variant_id: choice.chosen_variant_id, variant_label: choice.variant_label }
            : undefined,
        ),
        200,
      )
    },
  )
}
