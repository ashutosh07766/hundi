import { useState } from 'react'
import { usePolling } from '../hooks/use-polling.js'
import { FACILITATOR_URL } from '../lib/config.js'
import { formatPaise } from '../lib/format.js'
import { fetchSettlements, orderSummary, type SettlementListItem } from '../lib/orders.js'
import { OrderDetail } from './OrderDetail.js'

async function loadOrders(): Promise<SettlementListItem[]> {
  const settlements = await fetchSettlements(FACILITATOR_URL)
  return [...settlements].sort((a, b) => b.created_at - a.created_at)
}

/** Same tone vocabulary as the card `.pill--*` classes elsewhere (mandate
 * "Active"/"Revoked", pending-approval's merchant pill) — captured is the
 * only unambiguous success state, the terminal-bad states are danger,
 * everything still in flight (including pending_approval/settling) reads as
 * "in progress," not done. */
function stateTone(state: string): 'ok' | 'danger' | 'warn' {
  if (state === 'captured') return 'ok'
  if (state === 'failed' || state === 'rejected' || state === 'abandoned') return 'danger'
  return 'warn'
}

export function Orders() {
  const { data: settlements, error: pollError, loading } = usePolling(loadOrders, 3000)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const rows = settlements ?? []

  return (
    <section className="panel">
      <h2 className="panel__title">Orders</h2>
      <p className="panel__hint">
        Every settlement this facilitator has processed. Click one for the full receipt — products,
        payment, the authorizing mandate, and the audit timeline. Refreshes every 3 seconds.
      </p>

      {pollError && <div className="banner banner--error">Poll failed: {pollError}</div>}
      {loading && rows.length === 0 && <p className="panel__empty">Loading…</p>}
      {!loading && rows.length === 0 && !pollError && (
        <p className="panel__empty">No orders yet.</p>
      )}

      <div className="card-list">
        {rows.map((s) => {
          const summary = orderSummary(s)
          return (
            <button
              type="button"
              key={s.id}
              className="card order-card"
              onClick={() => setSelectedId(s.id)}
            >
              <div className="card__row">
                <span className={`pill pill--${stateTone(s.state)}`}>{s.state}</span>
                <span className="order-card__amount">{formatPaise(s.amount_paise)}</span>
              </div>
              <div className="card__row card__row--muted">
                <span>
                  {s.merchant_id} · {summary.itemCount} item{summary.itemCount === 1 ? '' : 's'}
                  {summary.firstItemSku ? ` — ${summary.firstItemSku}` : ''}
                </span>
                <span>{new Date(s.created_at * 1000).toLocaleString()}</span>
              </div>
              <div className="card__row card__row--muted order-card__id">
                <code className="hash">{s.id.slice(0, 12)}…</code>
              </div>
            </button>
          )
        })}
      </div>

      {selectedId && <OrderDetail settlementId={selectedId} onClose={() => setSelectedId(null)} />}
    </section>
  )
}
