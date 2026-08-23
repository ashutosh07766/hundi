import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url))
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8')

/**
 * Opens (creating if absent) the facilitator SQLite database at `path`, or an
 * in-memory database for `':memory:'`. Schema application is idempotent —
 * every DDL statement in schema.sql is `IF NOT EXISTS`, so this is safe to
 * call on every process start against an existing file.
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
