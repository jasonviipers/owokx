CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  default_severity TEXT NOT NULL DEFAULT 'warning',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_updated_at ON alert_rules(updated_at);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE ON UPDATE CASCADE,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_events_rule_id ON alert_events(rule_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_severity ON alert_events(severity);
CREATE INDEX IF NOT EXISTS idx_alert_events_occurred_at ON alert_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_acknowledged_at ON alert_events(acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_fingerprint ON alert_events(fingerprint);

INSERT OR IGNORE INTO alert_rules (id, title, description, enabled, default_severity, config_json)
VALUES
  (
    'portfolio_drawdown',
    'Portfolio Drawdown',
    'Triggers when portfolio drawdown approaches or breaches configured limits.',
    1,
    'warning',
    '{"drawdown_warn_ratio":0.8}'
  ),
  (
    'kill_switch_active',
    'Kill Switch Active',
    'Triggers when kill switch is enabled and trading is halted.',
    1,
    'critical',
    '{}'
  ),
  (
    'swarm_dead_letter_queue',
    'Swarm Dead Letter Queue',
    'Triggers when dead-letter queue depth exceeds warning or critical thresholds.',
    1,
    'warning',
    '{"dead_letter_warn":1,"dead_letter_critical":10}'
  ),
  (
    'llm_auth_failure',
    'LLM Auth Failure',
    'Triggers when recent LLM authentication failures are detected.',
    1,
    'warning',
    '{"auth_window_seconds":900}'
  );
