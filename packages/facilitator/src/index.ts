// Facilitator service — verifies and settles mandate chains against Razorpay.
export { openDb, tx } from './db/index.js'
export type { AppendLedgerInput, LedgerEventType, VerifyLedgerResult } from './ledger.js'
export { appendLedger, GENESIS_HASH, verifyLedger } from './ledger.js'
export type {
  AttemptState,
  SettlementState,
  TransitionOpts,
} from './state-machine.js'
export {
  ATTEMPT_TRANSITIONS,
  InvalidTransition,
  SETTLEMENT_TRANSITIONS,
  StaleTransition,
  transitionAttempt,
  transitionSettlement,
} from './state-machine.js'
