// Facilitator service — verifies and settles mandate chains against Razorpay.
export type { AppDeps } from './app.js'
export { createApp } from './app.js'
export { openDb, tx } from './db/index.js'
export type { Env } from './env.js'
export { loadEnv } from './env.js'
export type { ApiErrorBody, HttpStatus } from './errors.js'
export { errorBody, isSqliteConstraintError, RouteError } from './errors.js'
export type { Executor } from './executor.js'
export { noopExecutor } from './executor.js'
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
