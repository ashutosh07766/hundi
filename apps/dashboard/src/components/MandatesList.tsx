import type { IntentMandate } from '@hundi/core'
import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { usePolling } from '../hooks/use-polling.js'
import type { MandateListItem } from '../lib/api.js'
import { listMandates, postRevoke } from '../lib/api.js'
import { formatPaise } from '../lib/format.js'
import { signRevoke } from '../lib/intent.js'

type RowStatus = { pending: boolean; error: string | null }

function safeParseIntent(intentJson: string): IntentMandate | null {
  try {
    return JSON.parse(intentJson) as IntentMandate
  } catch {
    return null
  }
}

export function MandatesList() {
  const { human } = useIdentity()
  const { data: mandates, error: pollError, loading } = usePolling(listMandates, 2000)
  const [statusById, setStatusById] = useState<Record<string, RowStatus>>({})

  async function revoke(mandateId: string) {
    setStatusById((prev) => ({ ...prev, [mandateId]: { pending: true, error: null } }))
    try {
      const sig = signRevoke(mandateId, human)
      await postRevoke({ mandateId, sig })
      setStatusById((prev) => ({ ...prev, [mandateId]: { pending: false, error: null } }))
    } catch (err) {
      setStatusById((prev) => ({
        ...prev,
        [mandateId]: { pending: false, error: err instanceof Error ? err.message : String(err) },
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
          const revoked = row.revoked_at !== null
          return (
            <article className="card" key={row.mandate_id}>
              <div className="card__row">
                <h3>{intent?.goal ?? '(unparseable intent)'}</h3>
                {revoked ? (
                  <span className="pill pill--danger">Revoked</span>
                ) : (
                  <span className="pill pill--ok">Active</span>
                )}
              </div>
              <div className="card__row card__row--muted">
                <span>
                  {intent && (
                    <>
                      Ceiling {formatPaise(intent.ceiling_paise)} · Threshold{' '}
                      {formatPaise(intent.approval_threshold_paise)} · {intent.merchants.join(', ')}
                    </>
                  )}
                </span>
                <code className="hash">{row.mandate_id}</code>
              </div>
              <div className="card__actions">
                {!revoked && (
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={status?.pending}
                    onClick={() => revoke(row.mandate_id)}
                  >
                    {status?.pending ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
                {status?.error && <span className="status status--error">{status.error}</span>}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
