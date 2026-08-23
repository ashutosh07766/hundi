import type { IntentMandate } from '@hundi/core'
import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { usePolling } from '../hooks/use-polling.js'
import { loadAgentKeyRecord } from '../lib/agent-key.js'
import type { MandateListItem } from '../lib/api.js'
import { listMandates, postRevoke } from '../lib/api.js'
import type { TestPurchaseResult } from '../lib/buyer.js'
import { runTestPurchase } from '../lib/buyer.js'
import { FACILITATOR_URL } from '../lib/config.js'
import { formatPaise } from '../lib/format.js'
import { signRevoke } from '../lib/intent.js'
import { CheckCircleIcon, ClockIcon, XCircleIcon } from './icons.js'

type RowStatus = { pending: boolean; error: string | null }

type PurchaseKind = 'ok' | 'pending' | 'blocked' | 'error' | 'busy'
type PurchaseStatus = { kind: PurchaseKind; message: string }

function purchaseStatusClass(kind: PurchaseKind): string {
  if (kind === 'ok') return 'status-chip status-chip--ok'
  if (kind === 'pending') return 'status-chip status-chip--pending'
  if (kind === 'blocked' || kind === 'error') return 'status-chip status-chip--error'
  return 'status-chip status-chip--busy'
}

function PurchaseStatusIcon({ kind }: { kind: PurchaseKind }) {
  if (kind === 'ok') return <CheckCircleIcon />
  if (kind === 'pending') return <ClockIcon />
  if (kind === 'blocked' || kind === 'error') return <XCircleIcon />
  return <span className="spinner" aria-hidden="true" />
}

function outcomeKind(result: TestPurchaseResult): PurchaseKind {
  if (result.state === 'captured') return 'ok'
  if (result.state === 'pending_approval') return 'pending'
  return 'blocked'
}

function describeOutcome(result: TestPurchaseResult): string {
  const chosen = result.chosen
    ? `${result.chosen.title} at ${formatPaise(result.chosen.price_paise)}`
    : null
  const via = result.selection?.via === 'llm' ? ' (🧠 LLM pick)' : ''
  if (result.state === 'captured') return `Captured${chosen ? ` — ${chosen}${via}` : ''}`
  if (result.state === 'pending_approval') {
    return `Pending approval${chosen ? ` — ${chosen}${via}` : ''} — go to Pending approvals to sign off`
  }
  return `Blocked: ${result.reason ?? result.state}`
}

function safeParseIntent(intentJson: string): IntentMandate | null {
  try {
    return JSON.parse(intentJson) as IntentMandate
  } catch {
    return null
  }
}

export function MandatesList() {
  const { humanSign, dashboardToken } = useIdentity()
  const { data: mandates, error: pollError, loading } = usePolling(listMandates, 2000)
  const [statusById, setStatusById] = useState<Record<string, RowStatus>>({})
  const [purchaseById, setPurchaseById] = useState<Record<string, PurchaseStatus>>({})

  async function revoke(mandateId: string) {
    setStatusById((prev) => ({ ...prev, [mandateId]: { pending: true, error: null } }))
    try {
      const sig = await signRevoke(mandateId, humanSign)
      await postRevoke({ mandateId, sig })
      setStatusById((prev) => ({ ...prev, [mandateId]: { pending: false, error: null } }))
    } catch (err) {
      setStatusById((prev) => ({
        ...prev,
        [mandateId]: { pending: false, error: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  async function runTest(mandateId: string, intent: IntentMandate, poisoned: boolean) {
    const agentKey = loadAgentKeyRecord(mandateId)
    if (agentKey?.kind !== 'local') return
    setPurchaseById((prev) => ({ ...prev, [mandateId]: { kind: 'busy', message: 'shopping…' } }))
    try {
      const result = await runTestPurchase({
        mandateId,
        intent,
        agentKeyPair: agentKey,
        facilitatorUrl: FACILITATOR_URL,
        dashboardToken,
        poisoned,
        onStep: (message) =>
          setPurchaseById((prev) => ({ ...prev, [mandateId]: { kind: 'busy', message } })),
      })
      setPurchaseById((prev) => ({
        ...prev,
        [mandateId]: { kind: outcomeKind(result), message: describeOutcome(result) },
      }))
    } catch (err) {
      setPurchaseById((prev) => ({
        ...prev,
        [mandateId]: {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }

  const rows: MandateListItem[] = mandates ?? []

  return (
    <section className="panel">
      <h2 className="panel__title">Mandates</h2>
      <p className="panel__hint">
        Every intent this facilitator has registered. Refreshes every 2 seconds.
      </p>

      {pollError && <div className="banner banner--error">Poll failed: {pollError}</div>}
      {loading && rows.length === 0 && <p className="panel__empty">Loading…</p>}
      {!loading && rows.length === 0 && !pollError && (
        <p className="panel__empty">No mandates registered yet.</p>
      )}

      <div className="card-list">
        {rows.map((row) => {
          const intent = safeParseIntent(row.intent_json)
          const status = statusById[row.mandate_id]
          const purchase = purchaseById[row.mandate_id]
          const revoked = row.revoked_at !== null
          const agentKey = loadAgentKeyRecord(row.mandate_id)
          const canRunPurchase = agentKey?.kind === 'local'
          const purchaseDisabledTitle = canRunPurchase
            ? undefined
            : agentKey?.kind === 'external'
              ? 'agent key held externally'
              : 'no agent key stored for this mandate'
          const purchaseButtonsDisabled = !canRunPurchase || purchase?.kind === 'busy'
          return (
            <article
              className={`card mandate-card ${revoked ? 'mandate-card--revoked' : ''}`}
              key={row.mandate_id}
            >
              <div className="card__row">
                <h3>{intent?.goal ?? '(unparseable intent)'}</h3>
                {revoked ? (
                  <span className="pill pill--danger">Revoked</span>
                ) : (
                  <span className="pill pill--ok">Active</span>
                )}
              </div>

              {intent && (
                <dl className="mandate-card__stats">
                  <div className="mandate-card__stat">
                    <dt>Ceiling</dt>
                    <dd>{formatPaise(intent.ceiling_paise)}</dd>
                  </div>
                  <div className="mandate-card__stat">
                    <dt>Approval threshold</dt>
                    <dd>{formatPaise(intent.approval_threshold_paise)}</dd>
                  </div>
                  <div className="mandate-card__stat mandate-card__stat--wide">
                    <dt>Merchants</dt>
                    <dd>{intent.merchants.join(', ')}</dd>
                  </div>
                </dl>
              )}

              <div className="card__row card__row--muted mandate-card__id">
                <code className="hash">{row.mandate_id}</code>
              </div>

              <div className="card__actions">
                {intent && (
                  <>
                    <button
                      type="button"
                      className="btn btn--primary btn--small"
                      disabled={purchaseButtonsDisabled}
                      title={purchaseDisabledTitle}
                      onClick={() => runTest(row.mandate_id, intent, false)}
                    >
                      {purchase?.kind === 'busy' ? 'Running…' : 'Run test purchase'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      disabled={purchaseButtonsDisabled}
                      title={purchaseDisabledTitle}
                      onClick={() => runTest(row.mandate_id, intent, true)}
                    >
                      {purchase?.kind === 'busy' ? 'Running…' : 'Run scam test'}
                    </button>
                  </>
                )}
                {!revoked && (
                  <button
                    type="button"
                    className="btn btn--danger btn--small"
                    disabled={status?.pending}
                    onClick={() => revoke(row.mandate_id)}
                  >
                    {status?.pending ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
                {status?.error && <span className="status status--error">{status.error}</span>}
              </div>

              {purchase && (
                <p className={purchaseStatusClass(purchase.kind)}>
                  <PurchaseStatusIcon kind={purchase.kind} />
                  <span>{purchase.message}</span>
                </p>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
