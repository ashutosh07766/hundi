import { describe, expect, it } from 'vitest'
import type { LedgerEventType } from '../lib/narration.js'
import { describeLedgerEvent } from '../lib/narration.js'

describe('describeLedgerEvent', () => {
  it('narrates mandate_registered', () => {
    expect(
      describeLedgerEvent('mandate_registered', { agent_pubkey_hex: 'abcd1234ef00' }),
    ).toContain('abcd1234ef')
  })

  it('narrates mandate_revoked', () => {
    expect(describeLedgerEvent('mandate_revoked', {})).toMatch(/revoked/i)
  })

  it('narrates verify_passed', () => {
    expect(describeLedgerEvent('verify_passed', { mandate_cart_hash_hex: 'ff00' })).toMatch(
      /verify passed/i,
    )
  })

  it('narrates verify_rejected with reason and detail', () => {
    const text = describeLedgerEvent('verify_rejected', {
      reason: 'AMOUNT_EXCEEDS_CEILING',
      detail: 'cart total over ceiling',
    })
    expect(text).toContain('AMOUNT_EXCEEDS_CEILING')
    expect(text).toContain('cart total over ceiling')
  })

  it('narrates verify_rejected with a missing reason', () => {
    expect(describeLedgerEvent('verify_rejected', {})).toMatch(/unknown reason/i)
  })

  it('narrates approval_requested', () => {
    expect(describeLedgerEvent('approval_requested', { mandate_cart_hash_hex: 'ab12' })).toMatch(
      /approval requested/i,
    )
  })

  it('narrates approval_granted', () => {
    expect(describeLedgerEvent('approval_granted', {})).toMatch(/approved/i)
  })

  it('narrates approval_rejected', () => {
    expect(describeLedgerEvent('approval_rejected', {})).toMatch(/rejected by the human/i)
  })

  it('narrates approval_expired', () => {
    expect(describeLedgerEvent('approval_expired', {})).toMatch(/expired/i)
  })

  it('narrates settlement_created', () => {
    expect(describeLedgerEvent('settlement_created', {})).toMatch(/settlement created/i)
  })

  it('narrates attempt_initiated with method and attempt number', () => {
    const text = describeLedgerEvent('attempt_initiated', {
      method: 'checkout_driver',
      attempt_num: 2,
    })
    expect(text).toContain('#2')
    expect(text).toContain('checkout_driver')
  })

  it('narrates attempt_superseded', () => {
    expect(describeLedgerEvent('attempt_superseded', {})).toMatch(/superseded/i)
  })

  it('narrates payment_captured with payment id', () => {
    expect(
      describeLedgerEvent('payment_captured', { provider_payment_id: 'pay_abc123' }),
    ).toContain('pay_abc123')
  })

  it('narrates payment_failed with a reason', () => {
    expect(describeLedgerEvent('payment_failed', { reason: 'order_create_failed' })).toContain(
      'order_create_failed',
    )
  })

  it('narrates payment_link_issued with the short url', () => {
    expect(
      describeLedgerEvent('payment_link_issued', { short_url: 'https://rzp.io/l/abc' }),
    ).toContain('https://rzp.io/l/abc')
  })

  it('narrates anomaly_refund_issued with the payment id', () => {
    expect(describeLedgerEvent('anomaly_refund_issued', { payment_id: 'pay_xyz789' })).toContain(
      'pay_xyz789',
    )
  })

  it('narrates refund_issued with the refund id', () => {
    expect(describeLedgerEvent('refund_issued', { refund_id: 'rfnd_abc123' })).toContain(
      'rfnd_abc123',
    )
  })

  it('narrates webhook_received', () => {
    expect(describeLedgerEvent('webhook_received', {})).toMatch(/webhook received/i)
  })

  it('narrates webhook_rejected with a reason', () => {
    expect(describeLedgerEvent('webhook_rejected', { reason: 'bad signature' })).toContain(
      'bad signature',
    )
  })

  it('narrates reconciliation_flagged with a reason', () => {
    expect(
      describeLedgerEvent('reconciliation_flagged', { reason: 'capture_for_unknown_attempt' }),
    ).toContain('capture_for_unknown_attempt')
  })

  it('narrates agent_decision', () => {
    expect(describeLedgerEvent('agent_decision', { anything: true })).toMatch(/decision/i)
  })

  it('narrates settlement_abandoned', () => {
    expect(describeLedgerEvent('settlement_abandoned', {})).toMatch(/abandoned/i)
  })

  it('never throws on an empty payload for any event type', () => {
    const allTypes: LedgerEventType[] = [
      'mandate_registered',
      'mandate_revoked',
      'verify_passed',
      'verify_rejected',
      'approval_requested',
      'approval_granted',
      'approval_rejected',
      'approval_expired',
      'settlement_created',
      'attempt_initiated',
      'attempt_superseded',
      'payment_captured',
      'payment_failed',
      'payment_link_issued',
      'anomaly_refund_issued',
      'refund_issued',
      'webhook_received',
      'webhook_rejected',
      'reconciliation_flagged',
      'agent_decision',
      'settlement_abandoned',
    ]
    for (const type of allTypes) {
      expect(() => describeLedgerEvent(type, {})).not.toThrow()
      expect(describeLedgerEvent(type, {}).length).toBeGreaterThan(0)
    }
  })
})
