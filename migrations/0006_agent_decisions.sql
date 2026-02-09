CREATE TABLE IF NOT EXISTS agent_decisions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  temperature REAL NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_created_at ON agent_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_kind ON agent_decisions(kind);
