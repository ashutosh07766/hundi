/**
 * Thin typed wrapper around the Razorpay REST API. Every call goes through
 * `call()` so auth, timeout, and non-JSON-body handling stay in one place —
 * mirrors the `rzpFetch` pattern proven in spikes/rail-matrix/lib.ts, minus
 * the env-var reading (credentials are passed in explicitly so this module
 * has no process.env dependency and can be constructed per-request or once
 * at executor boot).
 */

const DEFAULT_BASE_URL = 'https://api.razorpay.com/v1'
const REQUEST_TIMEOUT_MS = 30_000

export type RazorpayOrder = {
  id: string
  amount: number
  currency: string
  receipt: string
  status: string
}

export type RazorpayPaymentLink = {
  id: string
  short_url: string
  status: string
}

export type RazorpayPayment = {
  id: string
  order_id?: string
  status: string
  amount: number
}

export type RazorpayRefund = {
  id: string
  payment_id: string
  status: string
  amount: number
}

/** Carries the HTTP status and parsed (or raw-text) body of a failed Razorpay call —
 * callers need the status to distinguish "bad request" from "provider outage". */
export class RazorpayApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`razorpay api error (status ${status}): ${JSON.stringify(body)}`)
    this.name = 'RazorpayApiError'
    this.status = status
    this.body = body
  }
}

export type RazorpayClientConfig = {
  keyId: string
  keySecret: string
  baseUrl?: string
}

export interface RazorpayClient {
  createOrder(input: { amountPaise: number; receipt: string }): Promise<RazorpayOrder>
  createPaymentLink(input: {
    amountPaise: number
    referenceId: string
  }): Promise<RazorpayPaymentLink>
  refundPayment(input: { paymentId: string; idempotencyKey: string }): Promise<RazorpayRefund>
  fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]>
}

export function createRazorpayClient(config: RazorpayClientConfig): RazorpayClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${auth}`,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new RazorpayApiError(0, { raw: `fetch_failed: ${message}` })
    }

    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { raw: text }
    }
    if (!res.ok) throw new RazorpayApiError(res.status, body)
    return body as T
  }

  return {
    createOrder({ amountPaise, receipt }) {
      return call<RazorpayOrder>('/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          receipt,
          payment_capture: 1,
        }),
      })
    },

    createPaymentLink({ amountPaise, referenceId }) {
      return call<RazorpayPaymentLink>('/payment_links', {
        method: 'POST',
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          reference_id: referenceId,
        }),
      })
    },

    // Razorpay's payment-refund idempotency is header-based only on RazorpayX;
    // the plain Payments Refund API has no such header, so the caller's
    // idempotencyKey travels in `notes` for audit and the caller (the
    // compensator in executor.ts) is responsible for not calling this twice
    // for the same payment — see handleProviderCapture's ledger dedupe check.
    refundPayment({ paymentId, idempotencyKey }) {
      return call<RazorpayRefund>(`/payments/${paymentId}/refund`, {
        method: 'POST',
        body: JSON.stringify({ notes: { hundi_idempotency_key: idempotencyKey } }),
      })
    },

    async fetchOrderPayments(orderId) {
      const res = await call<{ items: RazorpayPayment[] }>(`/orders/${orderId}/payments`)
      return res.items
    },
  }
}
