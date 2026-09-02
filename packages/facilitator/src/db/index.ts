import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url))
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8')

/**
 * Additive column migrations for tables that already exist in an older DB file.
 * `CREATE TABLE IF NOT EXISTS` in schema.sql never adds a column to a table that
 * already exists, so a column added to a table's definition after the DB was
 * first created must be backfilled here. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so each is guarded by a `table_info` check. Additive only — never drop/rename
 * (those need a real migration + backfill, not this). Table/column/type strings
 * are constants below, never user input, so the interpolation is safe.
 */
const COLUMN_MIGRATIONS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'mandate_proposals', column: 'per_merchant_ceiling_json', ddl: 'TEXT' },
  { table: 'mandate_proposals', column: 'cumulative_approval_threshold_paise', ddl: 'INTEGER' },
  { table: 'mandate_proposals', column: 'allowed_skus_json', ddl: 'TEXT' },
]

function applyColumnMigrations(db: Database.Database): void {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
  }
}

/** The quoted values inside `ledger_events`' `event_type IN (...)` CHECK, parsed
 * from a `CREATE TABLE` statement (the live table's or schema.sql's). */
function ledgerEventTypeCheckValues(createTableSql: string): Set<string> {
  const inClause = createTableSql.match(
    /event_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\([^)]*\(([^)]*)\)/is,
  )
  return new Set(
    [...(inClause?.[1] ?? '').matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] ? [m[1]] : [])),
  )
}

/**
 * Heals a stale `event_type` CHECK on an older `ledger_events`. `CREATE TABLE IF
 * NOT EXISTS` never rewrites an existing table's CHECK and SQLite has no `ALTER …
 * ALTER CONSTRAINT`, so a DB created before a new event type was added still
 * rejects it — the append fails at write time even though schema.sql lists it.
 *
 * The fix is a table rebuild: rename aside, recreate from the current schema,
 * copy every row verbatim (seq/prev_hash/row_hash included, so the hash chain
 * stays valid — verifyLedger re-hashes the copied bytes to the same digests),
 * drop the old. Nothing FK-references ledger_events, and its append-only
 * triggers guard UPDATE/DELETE, not the INSERT-copy or the DROP — but the
 * triggers are dropped first so schema.sql's `CREATE TRIGGER IF NOT EXISTS`
 * re-binds them to the new table instead of no-op'ing on the stale names.
 *
 * Runs only when the live CHECK is missing a value the current schema allows, so
 * it is a cheap sqlite_master read once healed. Additive-only by construction: a
 * value the live table permits but the schema dropped would still round-trip.
 */
function healLedgerEventTypeCheck(db: Database.Database): void {
  const live = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ledger_events'")
    .get() as { sql: string } | undefined
  if (!live) return

  const allowed = ledgerEventTypeCheckValues(SCHEMA_SQL)
  const present = ledgerEventTypeCheckValues(live.sql)
  const missingAllowedValue = [...allowed].some((v) => !present.has(v))
  if (!missingAllowedValue) return

  db.transaction(() => {
    db.exec(
      'DROP TRIGGER IF EXISTS ledger_events_no_update; DROP TRIGGER IF EXISTS ledger_events_no_delete;',
    )
    db.exec('ALTER TABLE ledger_events RENAME TO ledger_events_old')
    db.exec(SCHEMA_SQL)
    db.exec(
      `INSERT INTO ledger_events (seq, event_type, settlement_id, actor, payload, prev_hash, row_hash, created_at)
       SELECT seq, event_type, settlement_id, actor, payload, prev_hash, row_hash, created_at
       FROM ledger_events_old`,
    )
    db.exec('DROP TABLE ledger_events_old')
  })()
}

/**
 * Opens (creating if absent) the facilitator SQLite database at `path`, or an
 * in-memory database for `':memory:'`. Schema application is idempotent —
 * every DDL statement in schema.sql is `IF NOT EXISTS`, and additive column
 * changes to existing tables run through `applyColumnMigrations` — so this is
 * safe to call on every process start against an existing file.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path)
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  applyColumnMigrations(db)
  healLedgerEventTypeCheck(db)
  return db
}

/**
 * Runs `fn` inside an IMMEDIATE transaction: the write lock is acquired up
 * front rather than lazily on the first write, so two concurrent writers
 * fail fast with SQLITE_BUSY instead of deadlocking on lock upgrade.
 */
export function tx<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn).immediate()
}
