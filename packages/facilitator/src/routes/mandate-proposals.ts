/**
 * POST /mandates/propose is the "conversational mandate setup" entry point: an
 * agent (via the MCP server's prepare_mandate tool) describes a budget it wants
 * in natural language and this route stages it as an inert row. No auth token
 * gates this route on purpose — a proposal binds no credential, moves no money,
 * and cannot become a real mandate by itself. The human's signature, applied in
 * the dashboard against the EXISTING POST /mandates ceremony-token flow (see
 * routes/mandates.ts), is the only thing that ever gives a proposal's terms
 * actual spending authority. This file never writes to the `mandates` table.
 *
 * GET /mandates/proposals[/:id] is read-only and also unauthenticated — a human
 * who follows an approve_url from a fresh browser (no dashboard token saved yet)
 * still needs to see what the agent proposed before deciding whether to sign it.
 * POST /mandates/proposals/:id/consume is dashboard-only bookkeeping (marks a
 * proposal used once its real mandate is registered), gated the same way the
 * dashboard's other write-only routes are (see routes/ceremony-tokens.ts).
 */

import { randomUUID } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { RouteError } from '../errors.js'
import {
  consumeMandateProposal,
  effectiveStatus,
  getMandateProposal,
  insertMandateProposal,
  listMandateProposals,
  type MandateProposalRow,
} from '../mandate-proposal-repo.js'
import { requireHeaderToken } from '../middleware.js'
import { mandateProposeBodySchema } from '../schemas.js'
import { getStoreCatalog } from '../store-catalog-repo.js'

// How long a proposal's terms stay valid when the caller doesn't specify one — long
// enough that "give yourself a budget" survives a slow human without silently
// expiring, short enough that a stale, un-actioned proposal doesn't linger forever
// as a standing offer nobody asked for anymore.
const DEFAULT_PROPOSAL_TTL_SECONDS = 30 * 24 * 60 * 60

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function summarize(row: MandateProposalRow): string {
  const approvalNote =
    row.approval_threshold_paise >= row.ceiling_paise
      ? 'no purchases require approval'
      : `purchases over ${formatRupees(row.approval_threshold_paise)} require approval`
  return (
    `Give the agent up to ${formatRupees(row.ceiling_paise)} to "${row.goal}" at ${row.merchant_id} — ` +
    `${approvalNote}.`
  )
}

function toResponseRow(row: MandateProposalRow, nowSeconds: number) {
  return {
    id: row.id,
    merchant_id: row.merchant_id,
    goal: row.goal,
    ceiling_paise: row.ceiling_paise,
    approval_threshold_paise: row.approval_threshold_paise,
    currency: row.currency,
    agent_pubkey_hex: row.agent_pubkey_hex,
    expires_at: row.expires_at,
    status: effectiveStatus(row, nowSeconds),
    created_at: row.created_at,
    summary: summarize(row),
  }
}

export function registerMandateProposalRoutes(app: Hono, { db, env }: AppDeps): void {
  app.post('/mandates/propose', zValidator('json', mandateProposeBodySchema), (c) => {
    const body = c.req.valid('json')

    if (!getStoreCatalog(db, body.merchant_id)) {
      throw new RouteError(
        400,
        'UNKNOWN_MERCHANT',
        `No onboarded store with merchant_id "${body.merchant_id}"`,
      )
    }

    const id = randomUUID()
    const nowSeconds = Math.floor(Date.now() / 1000)
    const expiresAt = body.expires_at ?? nowSeconds + DEFAULT_PROPOSAL_TTL_SECONDS

    insertMandateProposal(db, {
      id,
      merchantId: body.merchant_id,
      goal: body.goal,
      ceilingPaise: body.ceiling_paise,
      approvalThresholdPaise: body.approval_threshold_paise,
      currency: 'INR',
      agentPubkeyHex: body.agent_pubkey_hex,
      expiresAt,
    })

    const dashboardUrl = (env.DASHBOARD_URL ?? 'http://localhost:5173').replace(/\/$/, '')
    const approveUrl = `${dashboardUrl}/?propose=${id}`

    return c.json({ ok: true, proposal_id: id, approve_url: approveUrl }, 201)
  })

  app.get('/mandates/proposals', (c) => {
    const statusFilter = c.req.query('status')
    const nowSeconds = Math.floor(Date.now() / 1000)
    const proposals = listMandateProposals(db)
      .map((row) => toResponseRow(row, nowSeconds))
      .filter((row) => !statusFilter || row.status === statusFilter)
    return c.json({ ok: true, proposals }, 200)
  })

  app.get('/mandates/proposals/:id', (c) => {
    const row = getMandateProposal(db, c.req.param('id'))
    if (!row) throw new RouteError(404, 'PROPOSAL_NOT_FOUND')
    return c.json({ ok: true, proposal: toResponseRow(row, Math.floor(Date.now() / 1000)) }, 200)
  })

  app.post(
    '/mandates/proposals/:id/consume',
    requireHeaderToken('x-hundi-dashboard-token', env.DASHBOARD_TOKEN),
    (c) => {
      const id = c.req.param('id')
      if (!getMandateProposal(db, id)) throw new RouteError(404, 'PROPOSAL_NOT_FOUND')
      const updated = consumeMandateProposal(db, id)
      if (!updated) throw new RouteError(404, 'PROPOSAL_NOT_FOUND')
      return c.json(
        { ok: true, proposal: toResponseRow(updated, Math.floor(Date.now() / 1000)) },
        200,
      )
    },
  )
}
