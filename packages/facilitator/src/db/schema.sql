-- Facilitator persistence schema. Executed idempotently via db.exec() on every open —
-- every statement uses IF NOT EXISTS so re-opening an existing DB file is a no-op.

CREATE TABLE IF NOT EXISTS mandates (
  mandate_id TEXT PRIMARY KEY,
  intent_json TEXT NOT NULL,
  intent_hash_hex TEXT NOT NULL UNIQUE,
  credential_type TEXT NOT NULL CHECK(credential_type IN ('ed25519','webauthn-es256')),
  credential_public_key TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS allowances (
  mandate_id TEXT PRIMARY KEY REFERENCES mandates(mandate_id),
  max_amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  expires_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'one_time',
  state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','reserved','consumed'))
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(mandate_id),
  cart_json TEXT NOT NULL,
  mandate_cart_hash_hex TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  merchant_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'created' CHECK(state IN (
    'created','verifying','verified','pending_approval','approved',
    'settling','captured','failed','rejected','abandoned'
  )),
  reject_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  verifying_at INTEGER,
  verified_at INTEGER,
  pending_approval_at INTEGER,
  approved_at INTEGER,
  settling_at INTEGER,
  captured_at INTEGER,
  failed_at INTEGER,
  rejected_at INTEGER,
  abandoned_at INTEGER,
  kick_count INTEGER NOT NULL DEFAULT 0
);

-- An allowance reservation is a live (non-terminal) settlement. A mandate can only
-- reserve one allowance at a time — this index IS the reservation lock.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_settlement_per_mandate
  ON settlements(mandate_id)
  WHERE state NOT IN ('captured','failed','rejected','abandoned');

-- Business rule: the same signed cart may not be settled twice. Terminal-failed
-- attempts free the hash for retry; captured/live attempts hold it.
CREATE UNIQUE INDEX IF NOT EXISTS one_settlement_per_cart
  ON settlements(mandate_cart_hash_hex)
  WHERE state NOT IN ('failed','rejected','abandoned');

CREATE TABLE IF NOT EXISTS settlement_attempts (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  method TEXT NOT NULL CHECK(method IN ('s2s_api','checkout_driver','payment_link')),
  state TEXT NOT NULL DEFAULT 'initiated' CHECK(state IN (
    'initiated','awaiting_confirmation','captured','failed','superseded'
  )),
  receipt TEXT NOT NULL UNIQUE,
  provider_order_id TEXT,
  provider_payment_id TEXT,
  provider_link_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- At most one in-flight attempt per settlement — prevents double-charging via a
-- concurrent second attempt while the first is still awaiting confirmation.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt
  ON settlement_attempts(settlement_id)
  WHERE state IN ('initiated','awaiting_confirmation');

-- At most one captured attempt per settlement — money invariant enforced by the DB,
-- not application logic.
CREATE UNIQUE INDEX IF NOT EXISTS one_captured_attempt
  ON settlement_attempts(settlement_id)
  WHERE state = 'captured';

-- PRIMARY KEY on settlement_id makes this write-once: a settlement gets exactly one
-- approval decision, ever. A re-decision requires a new settlement, not an update.
CREATE TABLE IF NOT EXISTS approvals (
  settlement_id TEXT PRIMARY KEY REFERENCES settlements(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  mandate_cart_hash_hex TEXT NOT NULL,
  sig_json TEXT NOT NULL,
  decided_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash_hex TEXT NOT NULL,
  settlement_id TEXT,
  locked_at INTEGER,
  response_status INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT,
  raw TEXT NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER
);

-- Row creation enforced create-only at the route layer, not here — SQLite has no
-- portable way to express "no UPDATE of this row after INSERT" declaratively.
CREATE TABLE IF NOT EXISTS merchants (
  merchant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  catalog_url TEXT,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Single-use dashboard-issued tokens that bind a mandate-registration ceremony to one
-- /mandates call. `used_at IS NULL` is the "still valid" predicate; consumption is a
-- conditional UPDATE, not a DELETE, so a spent token stays around as an audit trail.
CREATE TABLE IF NOT EXISTS ceremony_tokens (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  used_at INTEGER
);

-- The agent-feed-shape catalog for a store onboarded via POST /stores/onboard (or seeded
-- for the built-in demo store). Upsert-on-reonboard, unlike merchants: a store's real
-- catalog legitimately changes between scans, so the latest scan always wins. catalog_json
-- is the feed-shape products array (see routes/stores.ts's toFeedProducts) — GET
-- /catalog/:merchant_id serves it back verbatim (plus a poisoned listing when asked).
CREATE TABLE IF NOT EXISTS store_catalogs (
  merchant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_url TEXT,
  product_count INTEGER NOT NULL,
  catalog_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS ledger_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'mandate_registered','mandate_revoked',
    'verify_passed','verify_rejected',
    'approval_requested','approval_granted','approval_rejected','approval_expired',
    'settlement_created',
    'attempt_initiated','attempt_superseded',
    'payment_captured','payment_failed','payment_link_issued',
    'anomaly_refund_issued',
    'webhook_received','webhook_rejected',
    'reconciliation_flagged',
    'agent_decision',
    'settlement_abandoned'
  )),
  settlement_id TEXT,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Append-only: the hash chain's integrity guarantee is void the moment a row can be
-- rewritten in place. These triggers make that a DB-level fact, not a code convention.
CREATE TRIGGER IF NOT EXISTS ledger_events_no_update
BEFORE UPDATE ON ledger_events
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS ledger_events_no_delete
BEFORE DELETE ON ledger_events
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;
