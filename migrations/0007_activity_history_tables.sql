CREATE TABLE IF NOT EXISTS agent_activity_logs (
  id TEXT PRIMARY KEY,
  timestamp_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_logs_timestamp ON agent_activity_logs(timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_logs_event_type ON agent_activity_logs(event_type, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_logs_severity ON agent_activity_logs(severity, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_logs_status ON agent_activity_logs(status, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_logs_agent ON agent_activity_logs(agent, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_logs_action ON agent_activity_logs(action, timestamp_ms DESC);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  timestamp_ms INTEGER PRIMARY KEY,
  equity REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_created_at ON portfolio_snapshots(created_at);
