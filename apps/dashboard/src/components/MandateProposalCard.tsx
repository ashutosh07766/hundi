import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import type { MandateProposal } from '../lib/api.js'
import { formatPaise } from '../lib/format.js'
import { approveMandateProposal } from '../lib/proposal-approval.js'
import { SignatureIcon } from './icons.js'

type Props = {
  proposal: MandateProposal
  /** Set for the proposal the operator arrived at via an approve_url deep link — gets
   * a stronger visual treatment so it reads as "the thing you came here to do". */
  highlighted?: boolean
  onApproved: (mandateId: string) => void
}

/**
 * The one-tap approval surface for an agent-proposed mandate. Tapping "Approve"
 * drives the exact same signature + registration path the manual Mandate ceremony
 * tab uses (see lib/proposal-approval.ts) — the only difference is where the terms
 * came from. Whichever signer is active in Settings (passkey or local key) is what
 * actually authorizes the mandate; this component never touches a private key
 * itself, only the `humanSign`/`humanCredential` functions the identity context
 * exposes.
 */
export function MandateProposalCard({ proposal, highlighted, onApproved }: Props) {
  const { humanSign, humanCredential, dashboardToken } = useIdentity()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (proposal.status !== 'pending') return null

  const handsFree = proposal.approval_threshold_paise >= proposal.ceiling_paise

  async function handleApprove() {
    setError(null)
    if (!dashboardToken) {
      setError('Set the dashboard token in Settings before approving.')
      return
    }
    setBusy(true)
    try {
      const result = await approveMandateProposal({
        proposal,
        sign: humanSign,
        credential: humanCredential(),
        dashboardToken,
      })
      onApproved(result.mandateId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`card proposal-card ${highlighted ? 'proposal-card--highlighted' : ''}`}>
      <div className="card__row">
        <h3>🤖 Claude proposed a mandate</h3>
        <span className="pill pill--ok">{proposal.merchant_id}</span>
      </div>

      <p className="proposal-card__summary">{proposal.summary}</p>

      <dl className="mandate-card__stats">
        <div className="mandate-card__stat">
          <dt>Goal</dt>
          <dd>{proposal.goal}</dd>
        </div>
        <div className="mandate-card__stat">
          <dt>Up to</dt>
          <dd>{formatPaise(proposal.ceiling_paise)}</dd>
        </div>
        <div className="mandate-card__stat">
          <dt>Approvals</dt>
          <dd>
            {handsFree
              ? 'None — hands-free'
              : `Above ${formatPaise(proposal.approval_threshold_paise)}`}
          </dd>
        </div>
        {proposal.per_merchant_ceiling_paise &&
          Object.entries(proposal.per_merchant_ceiling_paise).map(([merchantId, paise]) => (
            <div className="mandate-card__stat" key={merchantId}>
              <dt>Max at {merchantId}</dt>
              <dd>{formatPaise(paise)}</dd>
            </div>
          ))}
        {proposal.cumulative_approval_threshold_paise !== undefined && (
          <div className="mandate-card__stat">
            <dt>Approval required above (cumulative)</dt>
            <dd>{formatPaise(proposal.cumulative_approval_threshold_paise)}</dd>
          </div>
        )}
      </dl>

      <p className="proposal-card__disclosure">
        You're approving the budget once. Claude spends within it without asking again, up to the
        ceiling. It can never raise this limit or approve its own purchases.
      </p>

      <div className="card__actions">
        <button
          type="button"
          className="btn btn--primary btn--icon"
          disabled={busy}
          onClick={handleApprove}
        >
          <SignatureIcon />
          {busy ? 'Approving…' : 'Approve with one tap'}
        </button>
        {error && <span className="status status--error">{error}</span>}
      </div>
    </article>
  )
}
