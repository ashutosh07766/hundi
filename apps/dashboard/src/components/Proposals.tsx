import { useState } from 'react'
import { usePolling } from '../hooks/use-polling.js'
import { getMandateProposal, listMandateProposals } from '../lib/api.js'
import { MandateProposalCard } from './MandateProposalCard.js'

/** The proposal id from an approve_url deep link (`/?propose=<id>`), read once on
 * mount — App.tsx's tab routing already reads this same param to land here. */
function deepLinkProposalId(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('propose')
}

export function Proposals() {
  const [deepLinkId] = useState(deepLinkProposalId)
  const [approvedIds, setApprovedIds] = useState<ReadonlySet<string>>(new Set())
  const [lastApprovedMandateId, setLastApprovedMandateId] = useState<string | null>(null)

  const { data: deepLinkProposal, error: deepLinkError } = usePolling(
    () => (deepLinkId ? getMandateProposal(deepLinkId) : Promise.resolve(null)),
    3000,
  )
  const {
    data: pending,
    error: listError,
    loading,
  } = usePolling(() => listMandateProposals('pending'), 3000)

  function handleApproved(proposalId: string, mandateId: string) {
    setApprovedIds((prev) => new Set(prev).add(proposalId))
    setLastApprovedMandateId(mandateId)
  }

  const showDeepLinkCard =
    !!deepLinkId &&
    !!deepLinkProposal &&
    deepLinkProposal.status === 'pending' &&
    !approvedIds.has(deepLinkId)
  const showAlreadyActioned =
    !!deepLinkId &&
    !!deepLinkProposal &&
    deepLinkProposal.status !== 'pending' &&
    !approvedIds.has(deepLinkId)

  const rest = (pending ?? []).filter((p) => p.id !== deepLinkId && !approvedIds.has(p.id))

  return (
    <section className="panel">
      <h2 className="panel__title">Proposals</h2>
      <p className="panel__hint">
        Mandates an agent has proposed from chat (Claude's <code>prepare_mandate</code> tool).
        Nothing here can spend a rupee until you tap Approve — that one tap is your signature, and
        it's the only thing that turns a proposal into a real, spendable mandate.
      </p>

      {lastApprovedMandateId && (
        <div className="banner banner--success">
          Authorized — mandate <code>{lastApprovedMandateId}</code> registered. The agent can now
          shop within its ceiling.
        </div>
      )}

      {deepLinkId && deepLinkError && (
        <div className="banner banner--error">
          Couldn't load the proposed mandate: {deepLinkError}
        </div>
      )}
      {showAlreadyActioned && deepLinkProposal && (
        <div className="banner banner--warning">
          This proposal is already <strong>{deepLinkProposal.status}</strong> — nothing left to do
          here.
        </div>
      )}
      {showDeepLinkCard && deepLinkProposal && (
        <MandateProposalCard
          proposal={deepLinkProposal}
          highlighted
          onApproved={(mandateId) => handleApproved(deepLinkProposal.id, mandateId)}
        />
      )}

      {listError && <div className="banner banner--error">Poll failed: {listError}</div>}
      {loading && rest.length === 0 && !showDeepLinkCard && (
        <p className="panel__empty">Loading…</p>
      )}
      {!loading && rest.length === 0 && !showDeepLinkCard && !listError && (
        <p className="panel__empty">No pending proposals. Ask Claude to propose one.</p>
      )}

      <div className="card-list">
        {rest.map((proposal) => (
          <MandateProposalCard
            key={proposal.id}
            proposal={proposal}
            onApproved={(mandateId) => handleApproved(proposal.id, mandateId)}
          />
        ))}
      </div>
    </section>
  )
}
