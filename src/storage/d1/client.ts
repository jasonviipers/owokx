export class D1Client {
  constructor(private db: D1Database) {}

  async execute<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db
      .prepare(query)
      .bind(...params)
      .all<T>();
    return result.results;
  }

  async executeOne<T = unknown>(query: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.db
      .prepare(query)
      .bind(...params)
      .first<T>();
    return result;
  }

  async run(query: string, params: unknown[] = []): Promise<D1Result> {
    return this.db
      .prepare(query)
      .bind(...params)
      .run();
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.db.batch(statements);
  }

  prepare(query: string): D1PreparedStatement {
    return this.db.prepare(query);
  }
}

export interface ToolLogEntry {
  id: string;
  request_id: string;
  tool_name: string;
  input_hash: string;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  latency_ms: number | null;
  provider_calls: number;
  created_at: string;
}

export interface RiskStateRow {
  id: number;
  kill_switch_active: number;
  kill_switch_reason: string | null;
  kill_switch_at: string | null;
  daily_loss_usd: number;
  daily_loss_reset_at: string | null;
  daily_equity_start: number | null;
  max_symbol_exposure_pct: number | null;
  max_correlated_exposure_pct: number | null;
  max_portfolio_drawdown_pct: number | null;
  last_loss_at: string | null;
  cooldown_until: string | null;
  updated_at: string;
}

export interface OrderApprovalRow {
  id: string;
  preview_hash: string;
  order_params_json: string;
  policy_result_json: string;
  approval_token: string;
  token_hash: string | null;
  expires_at: string;
  state: string;
  reserved_at: string | null;
  reserved_by: string | null;
  reserved_until: string | null;
  submitted_at: string | null;
  failed_at: string | null;
  last_error_json: string | null;
  used_at: string | null;
  created_at: string;
}

export interface OrderSubmissionRow {
  id: string;
  idempotency_key: string;
  source: string;
  approval_id: string | null;
  broker_provider: string;
  request_json: string;
  state: string;
  broker_order_id: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface TradeRow {
  id: string;
  approval_id: string | null;
  alpaca_order_id: string;
  submission_id: string | null;
  broker_provider: string | null;
  broker_order_id: string | null;
  symbol: string;
  side: string;
  qty: number;
  requested_qty: number | null;
  requested_notional: number | null;
  asset_class: string | null;
  quote_ccy: string | null;
  order_type: string;
  limit_price: number | null;
  stop_price: number | null;
  status: string;
  filled_qty: number | null;
  filled_avg_price: number | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyConfigRow {
  id: number;
  config_json: string;
  updated_at: string;
}

export interface TradeJournalRow {
  id: string;
  trade_id: string | null;
  symbol: string;
  side: string;
  entry_price: number | null;
  entry_at: string | null;
  exit_price: number | null;
  exit_at: string | null;
  qty: number;
  pnl_usd: number | null;
  pnl_pct: number | null;
  hold_duration_mins: number | null;
  signals_json: string | null;
  technicals_json: string | null;
  regime_tags: string | null;
  event_ids: string | null;
  outcome: string | null;
  notes: string | null;
  lessons_learned: string | null;
  created_at: string;
  updated_at: string;
}

export interface StructuredEventRow {
  id: string;
  raw_event_id: string | null;
  event_type: string;
  symbols: string;
  summary: string;
  confidence: number;
  validated: number;
  validation_errors: string | null;
  trade_proposal_id: string | null;
  trade_id: string | null;
  created_at: string;
}

export interface ExperimentVariantRow {
  id: string;
  strategy_name: string;
  variant_name: string;
  params_json: string;
  status: string;
  is_champion: number;
  created_at: string;
  updated_at: string;
}

export interface ExperimentRunRow {
  id: string;
  strategy_name: string;
  variant_id: string | null;
  seed: number | null;
  status: string;
  config_json: string;
  summary_json: string | null;
  summary_artifact_key: string | null;
  equity_artifact_key: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentMetricRow {
  id: string;
  run_id: string;
  metric_name: string;
  metric_value: number;
  step: number | null;
  tags_json: string | null;
  recorded_at: string;
}

export function createD1Client(db: D1Database | undefined | null): D1Client {
  if (!db || typeof db.prepare !== "function") {
    throw new Error(
      'D1 binding "DB" is not configured. Ensure wrangler D1 binding name is "DB" and redeploy the Worker.'
    );
  }
  return new D1Client(db);
}
