CREATE TABLE IF NOT EXISTS decision_traces (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_trace_id TEXT,
  request_id TEXT,
  source TEXT NOT NULL,
  stage TEXT NOT NULL,
  decision_kind TEXT NOT NULL,
  model_provider TEXT,
  model_name TEXT,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  policy_json TEXT,
  final_action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  error_code TEXT,
  error_message TEXT,
  symbol TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_traces_created_at ON decision_traces(created_at);
CREATE INDEX IF NOT EXISTS idx_decision_traces_trace_id ON decision_traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_decision_traces_request_id ON decision_traces(request_id);
CREATE INDEX IF NOT EXISTS idx_decision_traces_source_stage ON decision_traces(source, stage);
CREATE INDEX IF NOT EXISTS idx_decision_traces_symbol ON decision_traces(symbol);
CREATE INDEX IF NOT EXISTS idx_decision_traces_status ON decision_traces(status);
