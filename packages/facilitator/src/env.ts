/**
 * Boot-time environment validation. Every credential and port the HTTP
 * surface needs is read once here and passed down as a typed `Env` object —
 * nothing downstream reads `process.env` directly, so a missing secret
 * fails at startup with a readable message instead of surfacing as a
 * mysterious 401/undefined deep in a request handler.
 */

import { z } from 'zod'

const envSchema = z.object({
  RAZORPAY_KEY_ID: z.string().min(1, 'RAZORPAY_KEY_ID is required'),
  RAZORPAY_KEY_SECRET: z.string().min(1, 'RAZORPAY_KEY_SECRET is required'),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1, 'RAZORPAY_WEBHOOK_SECRET is required'),
  DASHBOARD_TOKEN: z.string().min(1, 'DASHBOARD_TOKEN is required'),
  ADMIN_TOKEN: z.string().min(1, 'ADMIN_TOKEN is required'),
  DB_PATH: z.string().min(1).default('./hundi.db'),
  PORT: z.coerce.number().int().positive().default(8790),
  // Local host page the checkout driver points Playwright at (see rails/checkout-page.ts).
  // Distinct from PORT — it's a same-process HTTP server serving a static Standard
  // Checkout launcher page, not the facilitator API.
  CHECKOUT_PAGE_PORT: z.coerce.number().int().positive().default(8788),
  // How often the reconciliation sweep (sweep.ts) ticks in production (serve.ts).
  // Tests construct a sweep directly with their own interval/TTLs and never read this.
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(12_000),
  // The fixed cap on how long a `pending_approval` settlement waits for a human
  // decision before the sweep abandons it — capped further by the mandate's own
  // expiry (see /approvals, which computes the same min() at decision time).
  APPROVAL_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
  // Optional OpenAI-compatible chat endpoint for POST /agent/select (see
  // routes/agent.ts). All three or none — the route falls back to a cheapest-
  // in-budget pick whenever any is missing, so an incomplete trio degrades
  // visibly (via:'cheapest' in the response) rather than half-configuring a
  // client that fails on first use.
  LLM_BASE_URL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
})

export type Env = z.infer<typeof envSchema>

/**
 * Validates `source` (defaults to `process.env`) against the required shape.
 * Throws a single Error listing every missing/invalid key — callers should
 * let this crash the process at boot rather than catch and continue with a
 * partially-configured facilitator.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    )
    throw new Error(`Invalid facilitator environment configuration:\n${issues.join('\n')}`)
  }
  return result.data
}
