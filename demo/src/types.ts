/**
 * The shape every demo stage returns. `narration` is spoken-word length —
 * suitable to print on camera or read aloud during the recording — while
 * `ledgerEvents` is the ordered `event_type` sequence a viewer would see on
 * the ledger screen for the stage's headline settlement. `detail` carries
 * whatever a stage needed to prove its scenario beyond the headline fields
 * (sub-run results for a stage with more than one settlement, short URLs,
 * capture counts) — the vitest assertions and run-all.ts's pretty-printer
 * both read it, so it stays untyped-but-structured rather than being folded
 * into `StageOutcome` and forcing every stage into the same shape.
 */
export type StageOutcome = {
  stage: number
  title: string
  narration: string
  expectedTerminal: string
  ledgerEvents: string[]
}

export type StageRun<TDetail = Record<string, unknown>> = {
  outcome: StageOutcome
  detail: TDetail
}
