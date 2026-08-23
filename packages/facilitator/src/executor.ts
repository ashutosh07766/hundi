/**
 * Seam between the HTTP surface and settlement execution. Routes call
 * `execute()` after committing an `approved` state transition — it is a
 * fire-and-forget kick (no return value, no awaited completion) so the HTTP
 * response is never blocked on a payment attempt. The real Razorpay-backed
 * executor lands separately; until then `noopExecutor` lets every route be
 * built, tested, and deployed against this interface without a dependency
 * on that work landing first.
 */
export interface Executor {
  execute(settlementId: string): void
}

export const noopExecutor: Executor = {
  execute(_settlementId: string): void {
    // U7 fills this in.
  },
}
