import { useState } from 'react'
import { usePolling } from '../hooks/use-polling.js'
import type { VerifyLedgerResult } from '../lib/api.js'
import { listLedger, verifyLedgerChain } from '../lib/api.js'
import type { LedgerEventType } from '../lib/narration.js'
import { describeLedgerEvent } from '../lib/narration.js'
import { ShieldCheckIcon } from './icons.js'

async function loadLedger() {
  const events = await listLedger(100)
  return [...events].sort((a, b) => b.seq - a.seq)
}

/**
 * Purely presentational grouping of ledger event types into a visual tone —
 * green for money-moved-as-expected, red for rejected/blocked/reversed,
 * amber for anything still in flight or waiting on a decision. This does not
 * change what any event means; `describeLedgerEvent` remains the single
 * source of truth for event semantics.
 */
function eventTone(eventType: LedgerEventType): 'success' | 'danger' | 'warn' | 'neutral' {
  switch (eventType) {
    case 'mandate_registered':
    case 'verify_passed':
    case 'approval_granted':
    case 'payment_captured':
      return 'success'
    case 'mandate_revoked':
    case 'verify_rejected':
    case 'approval_rejected':
    case 'approval_expired':
    case 'payment_failed':
    case 'webhook_rejected':
    case 'reconciliation_flagged':
    case 'settlement_abandoned':
      return 'danger'
    case 'approval_requested':
    case 'settlement_created':
    case 'attempt_initiated':
    case 'attempt_superseded':
    case 'payment_link_issued':
    case 'anomaly_refund_issued':
    case 'agent_decision':
      return 'warn'
    default:
      return 'neutral'
  }
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
          className="btn btn--primary btn--icon"
          onClick={handleVerify}
          disabled={verifying}
        >
          <ShieldCheckIcon />
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
          <li className={`ledger__row ledger__row--${eventTone(ev.event_type)}`} key={ev.seq}>
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
