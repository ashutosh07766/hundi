// Minimal local host page for driving Razorpay's embedded Standard Checkout
// (checkout.js) headlessly. Order params (key/order_id/amount/currency) are
// read client-side from the page's own query string so `drive.ts` can hand
// Playwright a single fully-parameterized URL per run — no server-side
// templating, no server-held order state.
//
// The page never talks to Razorpay's REST API itself; it only loads
// checkout.js and opens the hosted payment overlay. All order creation and
// post-payment verification happens in `drive.ts` against the real API.

import type { Server } from 'node:http'
import { createServer } from 'node:http'

export interface CheckoutPageServerHandle {
  port: number
  close: () => Promise<void>
}

const PAGE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>checkout-driver spike</title>
</head>
<body>
  <script>
    // Exposed for Playwright to poll via page.evaluate — set only by the
    // Razorpay-invoked handler, never synthesized locally.
    window.__paymentResult = null
    window.__paymentFailed = null
    window.__onPaymentSuccess = function (response) {
      console.log('SPIKE_PAYMENT_SUCCESS ' + JSON.stringify(response))
      window.__paymentResult = response
    }
  </script>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    ;(function () {
      var params = new URLSearchParams(window.location.search)
      var options = {
        key: params.get('key'),
        order_id: params.get('order_id'),
        amount: params.get('amount'),
        currency: params.get('currency') || 'INR',
        name: 'checkout-driver spike',
        description: 'Hundi rail (b) spike',
        prefill: {
          contact: '9820481144',
          email: 'spike@example.com',
        },
        handler: window.__onPaymentSuccess,
        modal: {
          ondismiss: function () {
            console.log('SPIKE_CHECKOUT_DISMISSED')
          },
        },
      }

      function openCheckout() {
        console.log(
          'SPIKE_OPENING_CHECKOUT ' +
            JSON.stringify({ order_id: options.order_id, amount: options.amount }),
        )
        var rzp = new Razorpay(options)
        rzp.on('payment.failed', function (resp) {
          console.log('SPIKE_PAYMENT_FAILED ' + JSON.stringify(resp.error))
          window.__paymentFailed = resp.error
        })
        rzp.open()
      }

      // checkout.js loads via a blocking <script src> above, but Playwright's
      // domcontentloaded wait can still race the remote fetch. Poll for the
      // global instead of trusting a single onload callback.
      var deadline = Date.now() + 10000
      ;(function waitForRazorpay() {
        if (typeof Razorpay !== 'undefined') {
          openCheckout()
          return
        }
        if (Date.now() > deadline) {
          console.log('SPIKE_CHECKOUT_JS_LOAD_TIMEOUT')
          return
        }
        setTimeout(waitForRazorpay, 50)
      })()
    })()
  </script>
</body>
</html>
`

export function startCheckoutPageServer(port = 8788): Promise<CheckoutPageServerHandle> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    })
    server.once('error', reject)
    server.listen(port, () => {
      resolve({
        port,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
          }),
      })
    })
  })
}
