CREATE TABLE IF NOT EXISTS experiment_variants (
  id TEXT PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  variant_name TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_champion INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_name, variant_name)
);

CREATE INDEX IF NOT EXISTS idx_experiment_variants_strategy ON experiment_variants(strategy_name);
CREATE INDEX IF NOT EXISTS idx_experiment_variants_status ON experiment_variants(status);
CREATE INDEX IF NOT EXISTS idx_experiment_variants_champion ON experiment_variants(is_champion);

CREATE TABLE IF NOT EXISTS experiment_runs (
  id TEXT PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  variant_id TEXT REFERENCES experiment_variants(id),
  seed INTEGER,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  summary_json TEXT,
  summary_artifact_key TEXT,
  equity_artifact_key TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_experiment_runs_strategy ON experiment_runs(strategy_name);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_variant ON experiment_runs(variant_id);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_started_at ON experiment_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_status ON experiment_runs(status);

CREATE TABLE IF NOT EXISTS experiment_metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  step INTEGER,
  tags_json TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_experiment_metrics_run ON experiment_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_experiment_metrics_name ON experiment_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_experiment_metrics_recorded ON experiment_metrics(recorded_at);
