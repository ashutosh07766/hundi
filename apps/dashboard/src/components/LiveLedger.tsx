import { useState } from 'react'
import { usePolling } from '../hooks/use-polling.js'
import type { VerifyLedgerResult } from '../lib/api.js'
import { listLedger, verifyLedgerChain } from '../lib/api.js'
import { describeLedgerEvent } from '../lib/narration.js'

async function loadLedger() {
  const events = await listLedger(100)
  return [...events].sort((a, b) => b.seq - a.seq)
}

export function LiveLedger() {
  const { data: events, error: pollError, loading } = usePolling(loadLedger, 2000)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyLedgerResult | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  async function handleVerify() {
    setVerifying(true)
    setVerifyError(null)
    try {
      setVerifyResult(await verifyLedgerChain())
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err))
      setVerifyResult(null)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <section className="panel">
      <div className="panel__row">
        <div>
          <h2 className="panel__title">Live ledger</h2>
          <p className="panel__hint">
            Append-only, hash-chained record of every state transition. Refreshes every 2 seconds.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={handleVerify}
          disabled={verifying}
        >
          {verifying ? 'Verifying…' : 'Verify chain'}
        </button>
      </div>

      {verifyError && <div className="banner banner--error">{verifyError}</div>}
      {verifyResult && (
        <div className={`banner ${verifyResult.ok ? 'banner--success' : 'banner--error'}`}>
          {verifyResult.ok ? (
            <p>
              Chain intact — {verifyResult.count} events, head{' '}
              <code>{verifyResult.head.slice(0, 20)}…</code>. This confirms no event was altered or
              deleted through the API since genesis. It does not protect against the facilitator's
              own host directly rewriting the database file — that trust boundary needs an external
              anchor (e.g. periodically publishing the head hash somewhere this dashboard doesn't
              control) to close.
            </p>
          ) : (
            <p>
              Chain broken at sequence {verifyResult.brokenAtSeq} — an event was altered or removed
              after being written.
            </p>
          )}
        </div>
      )}

      {pollError && <div className="banner banner--error">Poll failed: {pollError}</div>}
      {loading && (events?.length ?? 0) === 0 && <p className="panel__empty">Loading…</p>}

      <ol className="ledger">
        {(events ?? []).map((ev) => (
          <li className="ledger__row" key={ev.seq}>
            <span className="ledger__seq">#{ev.seq}</span>
            <div className="ledger__body">
              <p className="ledger__narration">{describeLedgerEvent(ev.event_type, ev.payload)}</p>
              <p className="ledger__meta">
                {ev.actor} · {new Date(ev.created_at * 1000).toLocaleString()}
                {ev.settlement_id && <> · settlement {ev.settlement_id}</>}
              </p>
            </div>
            <code className="hash hash--dim">{ev.row_hash.slice(0, 10)}…</code>
          </li>
        ))}
      </ol>
    </section>
  )
}
