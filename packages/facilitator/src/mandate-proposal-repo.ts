/**
 * Persistence for `mandate_proposals` — inert staging drafts an agent asks the
 * facilitator to create ahead of a human signing the real mandate. A proposal
 * carries no authority of its own: nothing here binds a credential or moves
 * money, so this module has no signature-verification surface at all. The row
 * exists purely so the dashboard has something to render an "Approve with one
 * tap" card from; the actual mandate registration still goes through the
 * existing signed POST /mandates ceremony-token path (routes/mandates.ts).
 */

import type Database from 'better-sqlite3'

export type MandateProposalStatus = 'pending' | 'consumed' | 'expired'

export type MandateProposalRow = {
  id: string
  merchant_id: string
  goal: string
  ceiling_paise: number
  approval_threshold_paise: number
  currency: string
  agent_pubkey_hex: string
  expires_at: number
  status: MandateProposalStatus
  created_at: number
}

export type InsertMandateProposalArgs = {
  id: string
  merchantId: string
  goal: string
  ceilingPaise: number
  approvalThresholdPaise: number
  currency: string
  agentPubkeyHex: string
  expiresAt: number
}

export function insertMandateProposal(
  db: Database.Database,
  args: InsertMandateProposalArgs,
): void {
  db.prepare(
    `INSERT INTO mandate_proposals
       (id, merchant_id, goal, ceiling_paise, approval_threshold_paise, currency, agent_pubkey_hex, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.merchantId,
    args.goal,
    args.ceilingPaise,
    args.approvalThresholdPaise,
    args.currency,
    args.agentPubkeyHex,
    args.expiresAt,
  )
}

export function getMandateProposal(
  db: Database.Database,
  id: string,
): MandateProposalRow | undefined {
  return db.prepare('SELECT * FROM mandate_proposals WHERE id = ?').get(id) as
    | MandateProposalRow
    | undefined
}

export function listMandateProposals(db: Database.Database): MandateProposalRow[] {
  return db
    .prepare('SELECT * FROM mandate_proposals ORDER BY created_at DESC')
    .all() as MandateProposalRow[]
}

/** Flips a still-pending proposal to 'consumed'. A no-op success (not an error) when
 * it's already consumed — the dashboard calls this right after a successful POST
 * /mandates, and a retried request shouldn't fail the flow the second time. */
export function consumeMandateProposal(
  db: Database.Database,
  id: string,
): MandateProposalRow | undefined {
  db.prepare(
    `UPDATE mandate_proposals SET status = 'consumed' WHERE id = ? AND status != 'consumed'`,
  ).run(id)
  return getMandateProposal(db, id)
}

/** `status` as stored can lag reality — a 'pending' row past its `expires_at` is
 * effectively expired even before anything sweeps the column. Every reader computes
 * this instead of trusting the raw column, so an unswept row still reports correctly. */
export function effectiveStatus(
  row: MandateProposalRow,
  nowSeconds: number,
): MandateProposalStatus {
  if (row.status === 'pending' && row.expires_at < nowSeconds) return 'expired'
  return row.status
}
