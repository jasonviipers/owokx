-- Idempotent execution + safer approval storage + improved trade accounting (backward compatible)

-- ---------------------------------------------------------------------------
-- Order approvals: store hashed token + add reservation/state tracking
-- ---------------------------------------------------------------------------
ALTER TABLE order_approvals ADD COLUMN token_hash TEXT;
ALTER TABLE order_approvals ADD COLUMN state TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE order_approvals ADD COLUMN reserved_at TEXT;
ALTER TABLE order_approvals ADD COLUMN reserved_by TEXT;
ALTER TABLE order_approvals ADD COLUMN reserved_until TEXT;
ALTER TABLE order_approvals ADD COLUMN submitted_at TEXT;
ALTER TABLE order_approvals ADD COLUMN failed_at TEXT;
ALTER TABLE order_approvals ADD COLUMN last_error_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_approvals_token_hash ON order_approvals(token_hash);
CREATE INDEX IF NOT EXISTS idx_order_approvals_state ON order_approvals(state);
CREATE INDEX IF NOT EXISTS idx_order_approvals_reserved_until ON order_approvals(reserved_until);

-- ---------------------------------------------------------------------------
-- Order submissions: global idempotency anchor for ALL execution paths
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_submissions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  approval_id TEXT REFERENCES order_approvals(id),
  broker_provider TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL,
  broker_order_id TEXT,
  last_error_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_order_submissions_approval_id ON order_submissions(approval_id);
CREATE INDEX IF NOT EXISTS idx_order_submissions_state ON order_submissions(state);
CREATE INDEX IF NOT EXISTS idx_order_submissions_created_at ON order_submissions(created_at);

-- ---------------------------------------------------------------------------
-- Trades: add fields to stop mixing qty and notional into one column
-- ---------------------------------------------------------------------------
ALTER TABLE trades ADD COLUMN submission_id TEXT REFERENCES order_submissions(id);
ALTER TABLE trades ADD COLUMN broker_provider TEXT;
ALTER TABLE trades ADD COLUMN broker_order_id TEXT;
ALTER TABLE trades ADD COLUMN requested_qty REAL;
ALTER TABLE trades ADD COLUMN requested_notional REAL;
ALTER TABLE trades ADD COLUMN asset_class TEXT;
ALTER TABLE trades ADD COLUMN quote_ccy TEXT;

CREATE INDEX IF NOT EXISTS idx_trades_submission_id ON trades(submission_id);
CREATE INDEX IF NOT EXISTS idx_trades_broker_order_id ON trades(broker_order_id);
