// Rail (b) settlement driver: completes a Razorpay TEST-mode payment
// hands-free by Playwright driving the embedded Standard Checkout overlay
// (checkout.js) through the netbanking mock-bank flow. Promoted from
// spikes/checkout-driver/drive.ts (kept there, untouched, as the reference
// spike) into the trust boundary behind /settle — this is the only place in
// the facilitator that opens a browser or moves money via the checkout UI.
//
// The DOM handler (`window.__paymentResult`) is a latency signal, not the
// source of truth — headless browsers can lose postMessage/handler delivery
// in ways a human session wouldn't. Every run is confirmed against
// `GET /orders/:id/payments` via the injected RazorpayClient, which is the
// only place a `captured` or `failed` terminal status is authoritative.

import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, ConsoleMessage, FrameLocator, Page } from 'playwright'
import { chromium } from 'playwright'
import type { RazorpayClient } from '../razorpay-client.js'
import type { CheckoutPageServerHandle } from './checkout-page.js'
import { startCheckoutPageServer } from './checkout-page.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS_DIR = join(HERE, '..', '..', 'artifacts', 'checkout-driver')
const HANDLER_RACE_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 60_000
const TERMINAL_STATUSES = new Set(['captured', 'failed'])
const IFRAME_SELECTORS = ['iframe.razorpay-checkout-frame', 'iframe[src*="razorpay"]']

// Tried in order — Razorpay's test environment randomly flags some banks as
// "currently facing issues" (its own simulated outage) to test merchant
// handling of that state. Falling through the list keeps the driver working
// when the first pick is flagged that way on a given run.
const NETBANK_CANDIDATES = ['Canara Bank', 'Punjab National Bank - Retail Banking', 'IDBI']

/** Points the driver at a merchant's real Shopify cart permalink for a specific
 * variant instead of this process's own locally-hosted checkout-page host. */
export interface VariantCartTarget {
  /** The merchant's storefront origin (e.g. "https://my-store.myshopify.com"). */
  storeOrigin: string
  variantId: string
  qty: number
}

export interface SettleViaCheckoutArgs {
  orderId: string
  amountPaise: number
  /** UPI collect (success@razorpay / failure@razorpay) is Razorpay's documented test
   * mechanism, but this account's checkout never lists UPI as a payment method at
   * all — accepted for interface parity with a future UPI-enabled account, unused
   * by the current netbanking-only flow. */
  vpa?: string
  /** Which button to click on Razorpay's mock bank page. Defaults to 'success' — a
   * real settle attempt never asks for 'failure'; it exists for driver-level tests. */
  outcome?: 'success' | 'failure'
  /** When present, the browser's first navigation goes to this variant's Shopify
   * cart permalink (`{storeOrigin}/cart/{variantId}:{qty}`) instead of this
   * process's own locally-hosted checkout-page host — Shopify adds exactly that
   * variant to the cart and proceeds to its own checkout, so the merchant's order
   * records the chosen size/color. Every selector and timeout downstream is
   * unchanged: Razorpay's checkout.js overlay (iframe, Netbanking tab, mock-bank
   * buttons) renders identically regardless of which page embeds it, so the same
   * driving logic applies whether the embed is this process's local host page or
   * the merchant's real storefront. Absent → the existing local-host flow, byte-
   * for-byte unchanged. */
  variant?: VariantCartTarget
}

/** Pure — builds the Shopify variant cart permalink `settleViaCheckout` navigates
 * to when `args.variant` is present. Exported so the URL construction is testable
 * without driving a real (or mocked) browser through the full checkout flow. */
export function buildVariantCartUrl(variant: VariantCartTarget): string {
  const origin = variant.storeOrigin.replace(/\/$/, '')
  return `${origin}/cart/${encodeURIComponent(variant.variantId)}:${variant.qty}`
}

/** Pure — builds the URL to this process's own locally-hosted checkout-page host
 * (see checkout-page.ts), the non-variant navigation target. Exported for the same
 * testability reason as `buildVariantCartUrl`. */
export function buildLocalCheckoutUrl(args: {
  orderId: string
  amountPaise: number
  keyId: string
  port: number
}): string {
  return `http://localhost:${args.port}/?order_id=${encodeURIComponent(
    args.orderId,
  )}&amount=${args.amountPaise}&currency=INR&key=${encodeURIComponent(args.keyId)}`
}

export type DetectedVia = 'handler' | 'api-poll'

export interface SettleViaCheckoutResult {
  ok: boolean
  paymentId?: string
  /** Terminal status confirmed via the authoritative API poll. */
  status?: 'captured' | 'failed' | 'timeout'
  detectedVia?: DetectedVia
  signatureVerified?: boolean
  latencyMs: number
  /** Directory holding screenshot + HTML dump, only set on a failed run. */
  artifacts?: string
  error?: string
}

interface HandlerPayload {
  razorpay_payment_id: string
  razorpay_order_id: string
  razorpay_signature: string
}

function logStep(step: string, ok: boolean, data: unknown): void {
  console.log(JSON.stringify({ step, ok, data, ts: new Date().toISOString() }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function saveArtifacts(page: Page, consoleLog: string[]): Promise<string> {
  const dir = join(ARTIFACTS_DIR, String(Date.now()))
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => {})
  const html = await page.content().catch(() => '<failed to capture HTML>')
  await writeFile(join(dir, 'page.html'), html)
  await writeFile(join(dir, 'console.log'), consoleLog.join('\n'))
  return dir
}

async function resolveCheckoutFrame(page: Page): Promise<FrameLocator> {
  let lastErr: unknown
  for (const selector of IFRAME_SELECTORS) {
    try {
      await page.waitForSelector(selector, { timeout: 15_000, state: 'attached' })
      return page.frameLocator(selector)
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `checkout iframe never appeared (tried ${IFRAME_SELECTORS.join(', ')}): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  )
}

/**
 * Some Standard Checkout sessions prompt for a contact number even when
 * `prefill.contact` is set (observed intermittently in test mode). Best
 * effort: if no contact field shows up within the probe window, the flow
 * continues straight to method selection.
 */
async function dismissContactPromptIfPresent(frame: FrameLocator): Promise<void> {
  // Scoped to the contact field specifically — Razorpay's card-number, expiry, and
  // CVV inputs are also `type="tel"`, so a bare `input[type="tel"]` selector
  // reliably grabs the wrong field.
  const contactInput = frame
    .locator('input[name="contact"], input[data-testid="contactNumber"]')
    .first()
  try {
    await contactInput.waitFor({ state: 'visible', timeout: 5_000 })
  } catch {
    return
  }
  // Checkout v2 validates the number: all-9s ("9999999999") is rejected with
  // "Please enter a valid mobile number", silently blocking every later step.
  await contactInput.fill('')
  await contactInput.pressSequentially('9820481144', { delay: 30 })
  await contactInput.press('Tab') // blur → re-run checkout's validation on the new value
  const continueBtn = frame.getByRole('button', { name: /continue/i }).first()
  await continueBtn.click({ force: true }).catch(() => {})
  try {
    await contactInput.waitFor({ state: 'hidden', timeout: 8_000 })
  } catch {
    const validationMsg = await frame
      .locator('text=/valid mobile|valid email/i')
      .first()
      .textContent()
      .catch(() => null)
    throw new Error(`contact dialog did not dismiss${validationMsg ? `: ${validationMsg}` : ''}`)
  }
}

/**
 * Selects Netbanking, then tries each candidate bank until one actually opens
 * the mock bank popup. Netbanking's mock bank page is served directly by
 * Razorpay's own test infrastructure and has no OTP/device-fingerprinting/
 * fraud-scoring step — the card rail's OTP step never resolves under a
 * headless or headed automated browser (fingerprinting + risk-scoring
 * machinery stalls indefinitely), so this is the only automatable rail on
 * this account.
 */
async function selectNetbankingBank(context: BrowserContext, frame: FrameLocator): Promise<Page> {
  const netbankingTab = frame.getByText('Netbanking', { exact: true }).first()
  await netbankingTab.waitFor({ state: 'visible', timeout: 20_000 })
  await netbankingTab.click({ force: true })

  for (const bank of NETBANK_CANDIDATES) {
    const bankRow = frame.getByText(bank, { exact: true }).first()
    try {
      await bankRow.waitFor({ state: 'visible', timeout: 5_000 })
    } catch {
      continue
    }
    const popupPromise = context.waitForEvent('page', { timeout: 8_000 }).catch(() => null)
    await bankRow.click({ force: true })
    const popup = await popupPromise
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {})
      return popup
    }
    const flagged = await frame
      .locator('text=/currently facing issues/i')
      .first()
      .isVisible()
      .catch(() => false)
    logStep('netbank_candidate_no_popup', true, { bank, flagged })
  }
  throw new Error(
    `no netbanking candidate opened the mock bank popup: ${NETBANK_CANDIDATES.join(', ')}`,
  )
}

async function clickMockBankOutcome(bankPage: Page, outcome: 'success' | 'failure'): Promise<void> {
  const label = outcome === 'success' ? 'Success' : 'Failure'
  const button = bankPage.getByRole('button', { name: label, exact: true }).first()
  await button.waitFor({ state: 'visible', timeout: 15_000 })
  await button.click()
}

async function waitForHandlerResult(page: Page): Promise<HandlerPayload | null> {
  try {
    await page.waitForFunction(
      () => (globalThis as unknown as Record<string, unknown>).__paymentResult !== null,
      { timeout: HANDLER_RACE_TIMEOUT_MS },
    )
  } catch {
    return null
  }
  return page.evaluate(
    () => (globalThis as unknown as Record<string, unknown>).__paymentResult as HandlerPayload,
  )
}

async function pollForTerminalStatus(
  razorpay: RazorpayClient,
  orderId: string,
): Promise<{ status: 'captured' | 'failed' | 'timeout'; paymentId?: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const items = await razorpay.fetchOrderPayments(orderId)
      const latest = items.at(-1)
      if (latest) {
        logStep('api_poll_payments', true, { status: latest.status, paymentId: latest.id })
        if (TERMINAL_STATUSES.has(latest.status)) {
          return { status: latest.status as 'captured' | 'failed', paymentId: latest.id }
        }
      } else {
        logStep('api_poll_payments', true, { items: 0 })
      }
    } catch (err) {
      logStep('api_poll_payments', false, { message: err instanceof Error ? err.message : err })
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return { status: 'timeout' }
}

function verifySignature(payload: HandlerPayload, keySecret: string): boolean {
  const expected = createHmac('sha256', keySecret)
    .update(`${payload.razorpay_order_id}|${payload.razorpay_payment_id}`)
    .digest('hex')
  return expected === payload.razorpay_signature
}

/** Started once and reused for the lifetime of the process — the executor's
 * single-flight mutex means only one browser session ever talks to it at a time,
 * so there's no need to tear it down between attempts. */
let checkoutPageServer: Promise<CheckoutPageServerHandle> | undefined

function getCheckoutPageServer(port: number): Promise<CheckoutPageServerHandle> {
  if (!checkoutPageServer) checkoutPageServer = startCheckoutPageServer(port)
  return checkoutPageServer
}

export type CheckoutDriverConfig = {
  keyId: string
  keySecret: string
  razorpay: RazorpayClient
  /** Port for the local checkout host page. Defaults to 8788. */
  checkoutPagePort?: number
}

export interface CheckoutDriver {
  settleViaCheckout(args: SettleViaCheckoutArgs): Promise<SettleViaCheckoutResult>
}

export function createCheckoutDriver(config: CheckoutDriverConfig): CheckoutDriver {
  const port = config.checkoutPagePort ?? 8788

  return {
    async settleViaCheckout(args: SettleViaCheckoutArgs): Promise<SettleViaCheckoutResult> {
      const start = Date.now()
      const outcome = args.outcome ?? 'success'

      const consoleLog: string[] = []
      let browser: Browser | undefined
      let page: Page | undefined

      try {
        // The local checkout-page host is only needed for the non-variant path — a
        // variant navigation goes straight to the merchant's own storefront, so
        // starting it in that branch would be pure overhead with nothing to serve.
        const url = args.variant
          ? buildVariantCartUrl(args.variant)
          : buildLocalCheckoutUrl({
              orderId: args.orderId,
              amountPaise: args.amountPaise,
              keyId: config.keyId,
              port: (await getCheckoutPageServer(port)).port,
            })

        browser = await chromium.launch({ headless: true })
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
        page = await context.newPage()
        page.on('console', (msg: ConsoleMessage) => {
          consoleLog.push(`[console:${msg.type()}] ${msg.text()}`)
        })
        page.on('pageerror', (err) => {
          consoleLog.push(`[pageerror] ${err.message}`)
        })

        logStep('navigate', true, { url })
        // domcontentloaded only — checkout.js keeps a long-poll open for the
        // lifetime of the overlay, so networkidle never resolves.
        await page.goto(url, { waitUntil: 'domcontentloaded' })

        const frame = await resolveCheckoutFrame(page)
        await dismissContactPromptIfPresent(frame)

        const bankPage = await selectNetbankingBank(context, frame)
        await clickMockBankOutcome(bankPage, outcome)

        const handlerResult = await waitForHandlerResult(page)
        const detectedVia: DetectedVia = handlerResult ? 'handler' : 'api-poll'

        let signatureVerified: boolean | undefined
        if (handlerResult) {
          signatureVerified = verifySignature(handlerResult, config.keySecret)
        }

        // Authoritative regardless of what the DOM reported.
        const polled = await pollForTerminalStatus(config.razorpay, args.orderId)
        const latencyMs = Date.now() - start
        const ok = polled.status === 'captured' || polled.status === 'failed'

        if (!ok) {
          const artifacts = await saveArtifacts(page, consoleLog)
          return {
            ok: false,
            status: polled.status,
            detectedVia,
            ...(signatureVerified !== undefined ? { signatureVerified } : {}),
            latencyMs,
            artifacts,
            error: 'no terminal payment status observed within poll window',
          }
        }

        const paymentId = polled.paymentId ?? handlerResult?.razorpay_payment_id
        return {
          ok: true,
          ...(paymentId !== undefined ? { paymentId } : {}),
          status: polled.status,
          detectedVia,
          ...(signatureVerified !== undefined ? { signatureVerified } : {}),
          latencyMs,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logStep('drive_error', false, { message })
        const artifacts = page ? await saveArtifacts(page, consoleLog) : undefined
        return {
          ok: false,
          latencyMs: Date.now() - start,
          ...(artifacts !== undefined ? { artifacts } : {}),
          error: message,
        }
      } finally {
        await browser?.close()
      }
    },
  }
}
