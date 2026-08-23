/** Paise → a merchant-facing ₹ string, e.g. `320000` → `"₹3,200.00"`. */
export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
