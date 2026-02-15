ALTER TABLE risk_state ADD COLUMN max_symbol_exposure_pct REAL NOT NULL DEFAULT 0.25;
ALTER TABLE risk_state ADD COLUMN max_correlated_exposure_pct REAL NOT NULL DEFAULT 0.5;
ALTER TABLE risk_state ADD COLUMN max_portfolio_drawdown_pct REAL NOT NULL DEFAULT 0.15;

UPDATE risk_state
SET
  max_symbol_exposure_pct = COALESCE(NULLIF(max_symbol_exposure_pct, 0), 0.25),
  max_correlated_exposure_pct = COALESCE(NULLIF(max_correlated_exposure_pct, 0), 0.5),
  max_portfolio_drawdown_pct = COALESCE(NULLIF(max_portfolio_drawdown_pct, 0), 0.15)
WHERE id = 1;
