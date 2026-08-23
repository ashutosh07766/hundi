/**
 * Maps a ledger event into a human-readable sentence for the live-ledger
 * screen. The event-type union mirrors `LedgerEventType` in
 * packages/facilitator/src/ledger.ts (and the CHECK constraint in
 * db/schema.sql) — it's hand-mirrored rather than imported so this module
 * has no build-order dependency on the facilitator package; ledger events
 * already cross a JSON-over-HTTP boundary, so this is the same kind of
 * boundary-mirror the rest of the mandate chain uses (see @hundi/core's
 * IntentMandate/CartMandate, independently re-typed at every HTTP schema
 * layer). Payload shapes are read defensively — this is the one place in the
 * dashboard that renders arbitrary server-supplied JSON, and an unknown or
 * missing field must degrade to a plain sentence, never throw.
 */

export type LedgerEventType =
  | 'mandate_registered'
  | 'mandate_revoked'
  | 'verify_passed'
  | 'verify_rejected'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'approval_expired'
  | 'settlement_created'
  | 'attempt_initiated'
  | 'attempt_superseded'
  | 'payment_captured'
  | 'payment_failed'
  | 'payment_link_issued'
  | 'anomaly_refund_issued'
  | 'webhook_received'
  | 'webhook_rejected'
  | 'reconciliation_flagged'
  | 'agent_decision'
  | 'settlement_abandoned'

type LedgerPayload = Record<string, unknown>

function str(payload: LedgerPayload, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(payload: LedgerPayload, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' ? v : undefined
}

function short(hex: string | undefined): string {
  return hex ? `${hex.slice(0, 10)}…` : 'unknown'
}

/**
 * Purely presentational grouping of ledger event types into a visual tone —
 * green for money-moved-as-expected, red for rejected/blocked/reversed,
 * amber for anything still in flight or waiting on a decision. This does not
 * change what any event means; `describeLedgerEvent` remains the single
 * source of truth for event semantics. Shared by the Live ledger tab and the
 * per-order receipt timeline so both render the same event the same color.
 */
export function eventTone(eventType: LedgerEventType): 'success' | 'danger' | 'warn' | 'neutral' {
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

/** Renders one ledger event as a plain-English sentence. Exhaustive over
 * `LedgerEventType` — adding a new event type without a case here is a
 * compile error. */
export function describeLedgerEvent(eventType: LedgerEventType, payload: LedgerPayload): string {
  switch (eventType) {
    case 'mandate_registered':
      return `Mandate registered for agent ${short(str(payload, 'agent_pubkey_hex'))}.`
    case 'mandate_revoked':
      return 'Mandate revoked — it can no longer authorize new settlements.'
    case 'verify_passed':
      return `Verify passed — under the approval threshold, cleared to settle automatically (cart ${short(str(payload, 'mandate_cart_hash_hex'))}).`
    case 'verify_rejected': {
      const reason = str(payload, 'reason') ?? 'unknown reason'
      const detail = str(payload, 'detail')
      return `Verify rejected: ${reason}${detail ? ` (${detail})` : ''}.`
    }
    case 'approval_requested':
      return `Approval requested — cart exceeds the auto-approve threshold (cart ${short(str(payload, 'mandate_cart_hash_hex'))}).`
    case 'approval_granted':
      return 'Approved by the human — cleared to settle.'
    case 'approval_rejected':
      return 'Rejected by the human — settlement will not proceed.'
    case 'approval_expired':
      return 'Approval window expired before a decision was made.'
    case 'settlement_created':
      return 'Settlement created — entering verification.'
    case 'attempt_initiated': {
      const method = str(payload, 'method') ?? 'checkout'
      const attemptNum = num(payload, 'attempt_num')
      return `Payment attempt${attemptNum ? ` #${attemptNum}` : ''} started via ${method}.`
    }
    case 'attempt_superseded':
      return 'A prior payment attempt was superseded by a new one.'
    case 'payment_captured': {
      const paymentId = str(payload, 'provider_payment_id')
      return `Charged — payment ${paymentId ?? 'captured'}.`
    }
    case 'payment_failed': {
      const reason = str(payload, 'reason') ?? str(payload, 'error') ?? 'unknown reason'
      return `Payment attempt failed: ${reason}.`
    }
    case 'payment_link_issued': {
      const url = str(payload, 'short_url')
      return `Payment link issued${url ? `: ${url}` : '.'}`
    }
    case 'anomaly_refund_issued': {
      const paymentId = str(payload, 'payment_id')
      return `Anomaly refund issued for payment ${paymentId ?? 'unknown'} — money was captured outside an active settlement, so it was returned.`
    }
    case 'webhook_received':
      return 'Webhook received from the payment provider.'
    case 'webhook_rejected': {
      const reason = str(payload, 'reason')
      return `Webhook rejected${reason ? `: ${reason}` : ' — signature or shape did not validate'}.`
    }
    case 'reconciliation_flagged': {
      const reason = str(payload, 'reason') ?? 'unspecified'
      return `Reconciliation flagged: ${reason}.`
    }
    case 'agent_decision':
      return 'Agent recorded a decision on this settlement.'
    case 'settlement_abandoned':
      return 'Settlement abandoned — no further action will be taken.'
    default: {
      const exhaustive: never = eventType
      return `Unrecognized event: ${String(exhaustive)}`
    }
  }
}
