/** `checkout-driver.ts` has no browser-mocked coverage before this file — every
 * prior verification was manual, against a real browser (see spikes/checkout-
 * driver). These tests mock `playwright` and `node:fs/promises` so
 * `settleViaCheckout`'s branch logic (which URL the browser's first navigation
 * goes to) is checked without opening a real browser or writing real files.
 * The rest of the flow (resolving the Razorpay iframe, the netbanking mock
 * bank) is left unmocked and fails fast against the fake page — that failure
 * path is exactly what proves the navigation already happened before this
 * test's assertions run. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above imports; anything they close over must
// come from vi.hoisted so it exists by the time the factory runs.
const { gotoCalls, startCheckoutPageServerMock } = vi.hoisted(() => ({
  gotoCalls: [] as string[],
  startCheckoutPageServerMock: vi.fn().mockResolvedValue({ port: 8788, close: vi.fn() }),
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newContext: vi.fn(async () => ({
        newPage: vi.fn(async () => ({
          on: vi.fn(),
          goto: vi.fn(async (url: string) => {
            gotoCalls.push(url)
          }),
          // resolveCheckoutFrame tries every selector and throws once all fail — a
          // fast, deterministic way to reach settleViaCheckout's catch block
          // without a real DOM.
          waitForSelector: vi.fn().mockRejectedValue(new Error('mock: no checkout iframe')),
          screenshot: vi.fn().mockResolvedValue(undefined),
          content: vi.fn().mockResolvedValue('<html></html>'),
        })),
      })),
      close: vi.fn(async () => {}),
    })),
  },
}))

vi.mock('../rails/checkout-page.js', () => ({
  startCheckoutPageServer: startCheckoutPageServerMock,
}))

const { createCheckoutDriver, buildLocalCheckoutUrl, buildVariantCartUrl } = await import(
  '../rails/checkout-driver.js'
)
const { makeFakeRazorpay } = await import('./executor-helpers.js')

beforeEach(() => {
  gotoCalls.length = 0
  startCheckoutPageServerMock.mockClear()
})

describe('buildVariantCartUrl — pure', () => {
  it('builds a Shopify variant cart permalink', () => {
    const url = buildVariantCartUrl({
      storeOrigin: 'https://my-store.myshopify.com',
      variantId: '1002',
      qty: 1,
    })
    expect(url).toBe('https://my-store.myshopify.com/cart/1002:1')
  })

  it('trims a trailing slash on storeOrigin', () => {
    const url = buildVariantCartUrl({
      storeOrigin: 'https://my-store.myshopify.com/',
      variantId: '1002',
      qty: 2,
    })
    expect(url).toBe('https://my-store.myshopify.com/cart/1002:2')
  })

  it('encodes a variant id containing special characters', () => {
    const url = buildVariantCartUrl({
      storeOrigin: 'https://my-store.myshopify.com',
      variantId: 'weird/id with space',
      qty: 1,
    })
    expect(url).toBe('https://my-store.myshopify.com/cart/weird%2Fid%20with%20space:1')
  })
})

describe('buildLocalCheckoutUrl — pure', () => {
  it('builds the local checkout-page host URL unchanged from the pre-variant shape', () => {
    const url = buildLocalCheckoutUrl({
      orderId: 'order_abc',
      amountPaise: 320000,
      keyId: 'rzp_test_key',
      port: 8788,
    })
    expect(url).toBe(
      'http://localhost:8788/?order_id=order_abc&amount=320000&currency=INR&key=rzp_test_key',
    )
  })
})

describe('settleViaCheckout — initial navigation branch', () => {
  it('navigates to the variant cart permalink and never starts the local checkout-page host when a variant is present', async () => {
    const driver = createCheckoutDriver({
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      razorpay: makeFakeRazorpay(),
      checkoutPagePort: 9001,
    })

    await driver.settleViaCheckout({
      orderId: 'order_1',
      amountPaise: 320000,
      variant: { storeOrigin: 'https://my-store.myshopify.com', variantId: '1002', qty: 1 },
    })

    expect(gotoCalls).toEqual(['https://my-store.myshopify.com/cart/1002:1'])
    expect(startCheckoutPageServerMock).not.toHaveBeenCalled()
  })

  it('navigates to the local checkout-page host when no variant is present (unchanged flow)', async () => {
    const driver = createCheckoutDriver({
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      razorpay: makeFakeRazorpay(),
      checkoutPagePort: 9002,
    })

    await driver.settleViaCheckout({ orderId: 'order_2', amountPaise: 150000 })

    expect(gotoCalls).toEqual([
      'http://localhost:8788/?order_id=order_2&amount=150000&currency=INR&key=rzp_test_key',
    ])
    expect(startCheckoutPageServerMock).toHaveBeenCalledWith(9002)
  })
})
