import type { CartMandate, IntentMandate } from '@hundi/core'
import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { usePolling } from '../hooks/use-polling.js'
import type { MandateListItem, SettlementListItem } from '../lib/api.js'
import { listMandates, listSettlements, postApproval } from '../lib/api.js'
import { formatPaise } from '../lib/format.js'
import { signApprovalDecision } from '../lib/intent.js'

type Loaded = { settlements: SettlementListItem[]; mandatesById: Map<string, IntentMandate> }

type RowStatus = { pending: boolean; error: string | null; success: string | null }

async function loadPending(): Promise<Loaded> {
  const [settlements, mandates] = await Promise.all([
    listSettlements('pending_approval'),
    listMandates(),
  ])
  const mandatesById = new Map<string, IntentMandate>()
  for (const m of mandates as MandateListItem[]) {
    try {
      mandatesById.set(m.mandate_id, JSON.parse(m.intent_json) as IntentMandate)
    } catch {
      // A mandate row with unparseable intent_json is a facilitator bug, not
      // something this screen should crash over — it just loses its goal/ceiling
      // context and falls back to raw ids below.
    }
  }
  return { settlements, mandatesById }
}

export function PendingApprovals() {
  const { humanSign } = useIdentity()
  const { data, error: pollError, loading } = usePolling(loadPending, 2000)
  const [statusById, setStatusById] = useState<Record<string, RowStatus>>({})

  async function decide(settlement: SettlementListItem, decision: 'approved' | 'rejected') {
    setStatusById((prev) => ({
      ...prev,
      [settlement.id]: { pending: true, error: null, success: null },
    }))
    try {
      const sig = await signApprovalDecision(
        {
          settlementId: settlement.id,
          mandateCartHashHex: settlement.mandate_cart_hash_hex,
          decision,
        },
        humanSign,
      )
      const result = await postApproval({
        settlement_id: settlement.id,
        mandate_cart_hash_hex: settlement.mandate_cart_hash_hex,
        decision,
        sig,
      })
      setStatusById((prev) => ({
        ...prev,
        [settlement.id]: { pending: false, error: null, success: `→ ${result.state}` },
      }))
    } catch (err) {
      setStatusById((prev) => ({
        ...prev,
        [settlement.id]: {
          pending: false,
          error: err instanceof Error ? err.message : String(err),
          success: null,
        },
      }))
    }
  }

  const settlements = data?.settlements ?? []

  return (
    <section className="panel">
      <h2 className="panel__title">Pending approvals</h2>
      <p className="panel__hint">
        Settlements whose cart total crossed the mandate's approval threshold, waiting on a human
        decision. Refreshes every 2 seconds.
      </p>

      {pollError && <div className="banner banner--error">Poll failed: {pollError}</div>}
      {loading && settlements.length === 0 && <p className="panel__empty">Loading…</p>}
      {!loading && settlements.length === 0 && !pollError && (
        <p className="panel__empty">No settlements waiting on approval.</p>
      )}

      <div className="card-list">
        {settlements.map((s) => {
          const intent = data?.mandatesById.get(s.mandate_id)
          const cart = safeParseCart(s.cart_json)
          const status = statusById[s.id]
          return (
            <article className="card" key={s.id}>
              <div className="card__row">
                <h3>{intent?.goal ?? '(mandate details unavailable)'}</h3>
                <span className="pill">{s.merchant_id}</span>
              </div>
              <div className="card__row card__row--muted">
                <span>
                  Total <strong>{formatPaise(s.amount_paise)}</strong>
                  {intent && <> · Threshold {formatPaise(intent.approval_threshold_paise)}</>}
                </span>
                <code className="hash">{s.mandate_cart_hash_hex.slice(0, 16)}…</code>
              </div>
              {cart && (
                <ul className="line-items">
                  {cart.items.map((item) => (
                    <li key={item.sku}>
                      {item.qty}× {item.sku} — {formatPaise(item.unit_price_paise * item.qty)}
                    </li>
                  ))}
                </ul>
              )}
              <div className="card__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={status?.pending}
                  onClick={() => decide(s, 'approved')}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={status?.pending}
                  onClick={() => decide(s, 'rejected')}
                >
                  Reject
                </button>
                {status?.success && <span className="status status--ok">{status.success}</span>}
                {status?.error && <span className="status status--error">{status.error}</span>}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function safeParseCart(cartJson: string): CartMandate | null {
  try {
    return JSON.parse(cartJson) as CartMandate
  } catch {
    return null
  }
}
