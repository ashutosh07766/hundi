// Rail (b) decision-critical driver: proves a Razorpay TEST-mode payment can
// be completed hands-free by Playwright driving the embedded Standard
// Checkout overlay (checkout.js), with no server-to-server payment-create
// call in the loop.
//
// The DOM handler (`window.__paymentResult`) is a latency signal, not the
// source of truth — headless browsers can lose postMessage/handler delivery
// in ways a human session wouldn't. Every run is confirmed against
// `GET /v1/orders/:id/payments`, which is the only place a `captured` or
// `failed` terminal status is authoritative.

import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, ConsoleMessage, FrameLocator, Page } from 'playwright'
import { chromium } from 'playwright'
import { logStep, requireEnv, rzpFetch, sleep } from '../rail-matrix/lib.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT_PORT = 8788
const HANDLER_RACE_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 60_000
const TERMINAL_STATUSES = new Set(['captured', 'failed'])
const IFRAME_SELECTORS = ['iframe.razorpay-checkout-frame', 'iframe[src*="razorpay"]']

// Netbanking bank list is tried in order — Razorpay's test environment
// randomly flags some banks as "currently facing issues" (its own simulated
// outage, unrelated to automation) to test merchant handling of that state.
// Falling through the list keeps the driver working when the first pick is
// flagged that way on a given run.
const NETBANK_CANDIDATES = ['Canara Bank', 'Punjab National Bank - Retail Banking', 'IDBI']

export interface SettleViaCheckoutArgs {
  orderId: string
  amountPaise: number
  /** Which button to click on Razorpay's mock bank page. Defaults to 'success'. */
  outcome?: 'success' | 'failure'
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

interface PaymentsListItem {
  id: string
  status: string
  [key: string]: unknown
}

interface PaymentsListResponse {
  entity: string
  count: number
  items: PaymentsListItem[]
}

interface HandlerPayload {
  razorpay_payment_id: string
  razorpay_order_id: string
  razorpay_signature: string
}

async function saveArtifacts(page: Page, consoleLog: string[]): Promise<string> {
  const dir = join(HERE, 'artifacts', String(Date.now()))
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
 * `prefill.contact` is set (observed intermittently in test mode). This is
 * best-effort: if no contact field shows up within the probe window, the
 * flow continues straight to method selection.
 */
async function dismissContactPromptIfPresent(frame: FrameLocator): Promise<void> {
  // Scoped to the contact field specifically — Razorpay's card-number,
  // expiry, and CVV inputs are also `type="tel"`, and Playwright's
  // visibility check doesn't account for a modal sitting on top of them, so
  // a bare `input[type="tel"]` selector reliably grabs the wrong field.
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
  // Clear any prefill first — pressSequentially appends to existing content.
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

// UPI collect (success@razorpay / failure@razorpay pseudo-VPAs) is
// Razorpay's documented test-mode mechanism, but this account's checkout
// never lists UPI as a payment method at all (verified: zero "UPI" or "upi"
// occurrences anywhere in the checkout iframe's rendered DOM, across many
// fresh orders — not a selector miss, the method category is absent).
// Left in place, unused, so the driver can swap back to UPI for the demo
// narrative if the account is later enabled for it — the rest of the file
// (contact dialog, handler race, API poll) is unaffected by which method
// selection path runs.
export async function selectUpiMethod(frame: FrameLocator): Promise<void> {
  const upiOption = frame.getByText('UPI', { exact: false }).first()
  await upiOption.waitFor({ state: 'visible', timeout: 20_000 })
  await upiOption.click({ force: true })

  const enterUpiIdToggle = frame.getByText(/enter upi id/i).first()
  try {
    await enterUpiIdToggle.waitFor({ state: 'visible', timeout: 5_000 })
    await enterUpiIdToggle.click({ force: true })
  } catch {
    // Already on the VPA-entry view, or this checkout build has no QR step.
  }
}

export async function fillVpaAndPay(frame: FrameLocator, vpa: string): Promise<void> {
  const vpaInput = frame
    .locator('input[name="vpa"], input[placeholder*="UPI" i], input[placeholder*="@"]')
    .first()
  await vpaInput.waitFor({ state: 'visible', timeout: 15_000 })
  await vpaInput.pressSequentially(vpa, { delay: 30 })

  const payButton = frame
    .locator('button:has-text("Verify and Pay"), button:has-text("Pay")')
    .first()
  await payButton.click({ force: true })
}

/**
 * Selects Netbanking, then tries each candidate bank until one actually
 * opens the mock bank popup. This is the verified-reliable path: the card
 * method's OTP step loads Sardine.ai device fingerprinting (with port
 * scanning enabled) plus Stripe Radar / hCaptcha, and under Playwright that
 * step never resolves — confirmed stuck on "Sending OTP" for 90+ seconds
 * with zero further network activity, reproduced under both headless
 * bundled Chromium and headed real Chrome with automation-detection flags
 * disabled. Netbanking's mock bank page is served directly by Razorpay's
 * own test infrastructure (`mocksharp`) and carries none of that
 * risk-scoring machinery.
 *
 * A bank click either opens the popup (Razorpay's `window.open` to
 * `/v1/gateway/mocksharp/payment`) or renders the "currently facing issues"
 * banner in place — the two are raced per candidate so the fallback list
 * doesn't stall behind a fixed timeout on every flagged bank. Returns the
 * resolved mock-bank `Page` directly rather than the bank name, since the
 * popup is the artifact callers need next.
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

// No DOM lib in this package's tsconfig (node-only scripts elsewhere in
// spikes/), so the in-browser callbacks below read through `globalThis`
// rather than the `window` identifier.
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
  orderId: string,
): Promise<{ status: 'captured' | 'failed' | 'timeout'; paymentId?: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const listRes = await rzpFetch<PaymentsListResponse>(`/orders/${orderId}/payments`)
    if (listRes.ok && 'items' in listRes.body) {
      const items = (listRes.body as PaymentsListResponse).items
      const latest = items.at(-1)
      if (latest) {
        logStep('api_poll_payments', true, { status: latest.status, paymentId: latest.id })
        if (TERMINAL_STATUSES.has(latest.status)) {
          return { status: latest.status as 'captured' | 'failed', paymentId: latest.id }
        }
      } else {
        logStep('api_poll_payments', true, { items: 0 })
      }
    } else {
      logStep('api_poll_payments', false, listRes.body)
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

export async function settleViaCheckout(
  args: SettleViaCheckoutArgs,
): Promise<SettleViaCheckoutResult> {
  const start = Date.now()
  const keyId = requireEnv('RAZORPAY_KEY_ID')
  const keySecret = requireEnv('RAZORPAY_KEY_SECRET')
  const outcome = args.outcome ?? 'success'

  const consoleLog: string[] = []
  let browser: Browser | undefined
  let page: Page | undefined

  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    page = await context.newPage()
    page.on('console', (msg: ConsoleMessage) => {
      const line = `[console:${msg.type()}] ${msg.text()}`
      consoleLog.push(line)
      logStep('browser_console', true, { text: msg.text() })
    })
    page.on('pageerror', (err) => {
      consoleLog.push(`[pageerror] ${err.message}`)
      logStep('browser_pageerror', false, { message: err.message })
    })

    const url = `http://localhost:${CHECKOUT_PORT}/?order_id=${encodeURIComponent(
      args.orderId,
    )}&amount=${args.amountPaise}&currency=INR&key=${encodeURIComponent(keyId)}`
    logStep('navigate', true, { url })
    // domcontentloaded only — checkout.js keeps a long-poll open for the
    // lifetime of the overlay, so networkidle never resolves.
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const frame = await resolveCheckoutFrame(page)
    logStep('iframe_resolved', true, {})

    await dismissContactPromptIfPresent(frame)
    logStep('contact_prompt_handled', true, {})

    const bankPage = await selectNetbankingBank(context, frame)
    logStep('mock_bank_page_resolved', true, { url: bankPage.url() })

    await clickMockBankOutcome(bankPage, outcome)
    logStep('mock_bank_outcome_clicked', true, { outcome })

    const handlerResult = await waitForHandlerResult(page)
    const detectedVia: DetectedVia = handlerResult ? 'handler' : 'api-poll'
    logStep('handler_race_result', true, { detectedVia, fired: handlerResult !== null })

    let signatureVerified: boolean | undefined
    if (handlerResult) {
      signatureVerified = verifySignature(handlerResult, keySecret)
      logStep('signature_verify', signatureVerified, {
        orderId: handlerResult.razorpay_order_id,
        paymentId: handlerResult.razorpay_payment_id,
      })
    }

    // Authoritative regardless of what the DOM reported.
    const polled = await pollForTerminalStatus(args.orderId)
    const latencyMs = Date.now() - start
    const ok = polled.status === 'captured' || polled.status === 'failed'

    if (!ok) {
      const artifacts = await saveArtifacts(page, consoleLog)
      return {
        ok: false,
        status: polled.status,
        detectedVia,
        signatureVerified,
        latencyMs,
        artifacts,
        error: 'no terminal payment status observed within poll window',
      }
    }

    return {
      ok: true,
      paymentId: polled.paymentId ?? handlerResult?.razorpay_payment_id,
      status: polled.status,
      detectedVia,
      signatureVerified,
      latencyMs,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logStep('drive_error', false, { message })
    const artifacts = page ? await saveArtifacts(page, consoleLog) : undefined
    return {
      ok: false,
      latencyMs: Date.now() - start,
      artifacts,
      error: message,
    }
  } finally {
    await browser?.close()
  }
}
