// Minimal local webhook receiver for Razorpay test-mode events, meant to sit
// behind a `cloudflared tunnel` (see README.md). Verifies
// `x-razorpay-signature` as HMAC-SHA256 of the *raw* request body against
// RAZORPAY_WEBHOOK_SECRET, using a constant-time compare. Always responds
// 200 — Razorpay retries on non-2xx, and a broken local listener should not
// turn into a retry storm against the account while the spike is running.
//
// Run with --no-verify before the webhook secret is configured in the
// Razorpay dashboard (verification is skipped, but every event still logs).

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { loadEnv, logStep, requireEnv } from './lib.ts'

loadEnv()

const PORT = 8787
const noVerify = process.argv.includes('--no-verify')

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signatureHeader, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
  const rawBody = await readRawBody(req)
  const signatureHeader = req.headers['x-razorpay-signature'] as string | undefined
  const eventId = req.headers['x-razorpay-event-id'] as string | undefined

  let verified = false
  if (noVerify) {
    verified = false
  } else {
    const secret = requireEnv('RAZORPAY_WEBHOOK_SECRET')
    verified = verifySignature(rawBody, signatureHeader, secret)
  }

  let parsedEvent: string | undefined
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as { event?: string }
    parsedEvent = parsed.event
  } catch {
    parsedEvent = undefined
  }

  logStep('webhook_received', true, {
    event_id: eventId,
    event: parsedEvent,
    verified,
    no_verify_mode: noVerify,
  })

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ received: true }))
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    handleWebhook(req, res).catch((err) => {
      // Fail loud in the log, but still 200 the request — see file header.
      logStep('webhook_handler_error', false, {
        message: err instanceof Error ? err.message : String(err),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ received: true }))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(PORT, () => {
  if (noVerify) {
    logStep('listening', true, {
      port: PORT,
      path: '/webhook',
      mode: 'NO_VERIFY — signature check is disabled, every event is logged as verified: false',
    })
  } else {
    logStep('listening', true, { port: PORT, path: '/webhook', mode: 'verifying' })
  }
})
