/**
 * Money formatting. Every amount that crosses the facilitator boundary is
 * integer paise (see @hundi/core's IntentMandate/CartMandate) — this module
 * is the only place the dashboard converts to rupees for display.
 */

const INR_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
})

export function paiseToRupees(paise: number): number {
  return paise / 100
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100)
}

/** Formats integer paise as a localized INR string, e.g. `320000` -> `"₹3,200.00"`. */
export function formatPaise(paise: number): string {
  return INR_FORMATTER.format(paiseToRupees(paise))
}
