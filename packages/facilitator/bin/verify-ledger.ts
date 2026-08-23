#!/usr/bin/env tsx
import process from 'node:process'
import { openDb } from '../src/db/index.js'
import { verifyLedger } from '../src/ledger.js'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: verify-ledger <db-path>')
  process.exit(1)
}

const db = openDb(dbPath)
const result = verifyLedger(db)

if (result.ok) {
  console.log(
    `Chain internally consistent: ${result.count} events from genesis, head ${result.head}. ` +
      'This proves no post-hoc edits within the recorded chain; it does not protect against ' +
      'full-chain rewrite by the database owner — anchor the head hash externally to close that.',
  )
} else {
  console.error(
    `Chain broken at seq ${result.brokenAtSeq}: stored row_hash does not match the recomputed hash.`,
  )
  process.exit(1)
}
