import type { IntentMandate } from '@hundi/core'
import { useEffect, useState } from 'react'
import { listMandates } from '../lib/api.js'
import { FACILITATOR_URL } from '../lib/config.js'
import { formatPaise } from '../lib/format.js'
import { describeLedgerEvent, eventTone } from '../lib/narration.js'
import {
  buildSkuTitleMap,
  capturedPayment,
  fetchCatalogCached,
  fetchSettlement,
  findMandateIntent,
  parseLedgerEvent,
  type SettlementDetailResponse,
  safeParseCart,
} from '../lib/orders.js'
import { XCircleIcon } from './icons.js'

type Props = { settlementId: string; onClose: () => void }

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      detail: SettlementDetailResponse
      skuTitles: Map<string, string>
      mandateIntent: IntentMandate | null
    }

function stateTone(state: string): 'ok' | 'danger' | 'warn' {
  if (state === 'captured') return 'ok'
  if (state === 'failed' || state === 'rejected' || state === 'abandoned') return 'danger'
  return 'warn'
}

/**
 * Full-order receipt: fetches the settlement's own detail (cart, payment
 * attempts, approval, ledger), the merchant's catalog (for sku -> product
 * name), and the mandates list (for the authorizing intent) in one pass on
 * open. A catalog-lookup failure degrades to showing raw skus — see
 * `fetchCatalogCached`'s doc comment — everything else fails loud into the
 * `error` state.
 */
export function OrderDetail({ settlementId, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    ;(async () => {
      try {
        const [detail, mandates] = await Promise.all([
          fetchSettlement(FACILITATOR_URL, settlementId),
          listMandates(),
        ])
        let skuTitles = new Map<string, string>()
        try {
          const catalog = await fetchCatalogCached(FACILITATOR_URL, detail.settlement.merchant_id)
          skuTitles = buildSkuTitleMap(catalog)
        } catch {
          // Catalog lookup is a display nicety (friendly product names), not
          // load-bearing for the receipt — fall through with raw skus.
        }
        if (cancelled) return
        setState({
          status: 'ready',
          detail,
          skuTitles,
          mandateIntent: findMandateIntent(mandates, detail.settlement.mandate_id),
        })
      } catch (err) {
        if (cancelled) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settlementId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Order receipt">
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close receipt">
          <XCircleIcon />
        </button>

        {state.status === 'loading' && <p className="panel__empty">Loading receipt…</p>}
        {state.status === 'error' && <div className="banner banner--error">{state.message}</div>}
        {state.status === 'ready' && <Receipt state={state} />}
      </div>
    </div>
  )
}

function Receipt({ state }: { state: Extract<LoadState, { status: 'ready' }> }) {
  const { detail, skuTitles, mandateIntent } = state
  const { settlement, attempts, ledger } = detail
  const cart = safeParseCart(settlement.cart_json)
  const payment = capturedPayment(attempts)
  const events = [...ledger].map(parseLedgerEvent).sort((a, b) => b.seq - a.seq)

  return (
    <>
      <header className="receipt__header">
        <div className="receipt__header-row">
          <span className="receipt__amount">{formatPaise(settlement.amount_paise)}</span>
          <span className={`pill pill--${stateTone(settlement.state)}`}>{settlement.state}</span>
        </div>
        <p className="receipt__meta">
          {settlement.merchant_id} · <code className="hash">{settlement.id}</code> ·{' '}
          {new Date(settlement.created_at * 1000).toLocaleString()}
        </p>
        {settlement.reject_reason && (
          <div className="banner banner--error">{settlement.reject_reason}</div>
        )}
      </header>

      <section className="receipt__section">
        <h3 className="receipt__section-title">Items</h3>
        {cart ? (
          <table className="receipt-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Sku</th>
                <th>Qty</th>
                <th>Unit price</th>
                <th>Line total</th>
              </tr>
            </thead>
            <tbody>
              {cart.items.map((item) => (
                <tr key={item.sku}>
                  <td>{skuTitles.get(item.sku) ?? item.sku}</td>
                  <td>
                    <code className="hash">{item.sku}</code>
                  </td>
                  <td>{item.qty}</td>
                  <td>{formatPaise(item.unit_price_paise)}</td>
                  <td>{formatPaise(item.unit_price_paise * item.qty)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>Total</td>
                <td>{formatPaise(cart.total_paise)}</td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <p className="panel__empty">Cart could not be parsed.</p>
        )}
      </section>

      <section className="receipt__section">
        <h3 className="receipt__section-title">Payment</h3>
        <dl className="receipt-facts">
          <div className="receipt-facts__item">
            <dt>Razorpay payment id</dt>
            <dd>
              {payment.paymentId ? (
                <code className="hash">{payment.paymentId}</code>
              ) : (
                '(not yet captured)'
              )}
            </dd>
          </div>
          <div className="receipt-facts__item">
            <dt>Razorpay order id</dt>
            <dd>{payment.orderId ? <code className="hash">{payment.orderId}</code> : '—'}</dd>
          </div>
          <div className="receipt-facts__item">
            <dt>Method</dt>
            <dd>{payment.method ?? '—'}</dd>
          </div>
        </dl>
        <p className="receipt__note">
          Real Razorpay TEST-mode payment. Look it up in the Razorpay Dashboard → Test mode →
          Transactions.
        </p>
      </section>

      <section className="receipt__section">
        <h3 className="receipt__section-title">Authorization</h3>
        {mandateIntent ? (
          <p className="receipt__note">
            Authorized by mandate "{mandateIntent.goal}" — cap{' '}
            {formatPaise(mandateIntent.ceiling_paise)}, approval over{' '}
            {formatPaise(mandateIntent.approval_threshold_paise)}.
          </p>
        ) : (
          <p className="panel__empty">Mandate details unavailable.</p>
        )}
        <dl className="receipt-facts">
          <div className="receipt-facts__item">
            <dt>Mandate id</dt>
            <dd>
              <code className="hash">{settlement.mandate_id.slice(0, 16)}…</code>
            </dd>
          </div>
          <div className="receipt-facts__item">
            <dt>Cart hash</dt>
            <dd>
              <code className="hash">{settlement.mandate_cart_hash_hex.slice(0, 16)}…</code>
            </dd>
          </div>
        </dl>
      </section>

      <section className="receipt__section">
        <h3 className="receipt__section-title">Timeline</h3>
        <ol className="ledger">
          {events.map((ev) => (
            <li className={`ledger__row ledger__row--${eventTone(ev.event_type)}`} key={ev.seq}>
              <div className="ledger__body">
                <p className="ledger__narration">
                  {describeLedgerEvent(ev.event_type, ev.payload)}
                </p>
                <p className="ledger__meta">{new Date(ev.created_at * 1000).toLocaleString()}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}
