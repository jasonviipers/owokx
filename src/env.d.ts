export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;
  SESSION: DurableObjectNamespace;
  MCP_AGENT: DurableObjectNamespace;
  OWOKX_HARNESS?: DurableObjectNamespace;
  DATA_SCOUT: DurableObjectNamespace;
  ANALYST: DurableObjectNamespace;
  TRADER: DurableObjectNamespace;
  SWARM_REGISTRY: DurableObjectNamespace;
  RISK_MANAGER: DurableObjectNamespace;
  LEARNING_AGENT?: DurableObjectNamespace;

  BROKER_PROVIDER?: "alpaca" | "okx" | "polymarket";
  BROKER_FALLBACK_PROVIDER?: "alpaca" | "okx" | "polymarket";
  BROKER_FALLBACK_ALLOW_TRADING?: string;

  ALPACA_API_KEY: string;
  ALPACA_API_SECRET: string;
  ALPACA_PAPER?: string;

  OKX_API_KEY?: string;
  OKX_SECRET?: string;
  OKX_PASSPHRASE?: string;
  OKX_BASE_URL?: string;
  OKX_SIMULATED_TRADING?: string;
  OKX_DEFAULT_QUOTE_CCY?: string;
  OKX_MAX_REQUESTS_PER_SECOND?: string;
  OKX_MAX_RETRIES?: string;
  OKX_LOG_LEVEL?: "debug" | "info" | "warn" | "error" | "silent";

  POLYMARKET_API_URL?: string;
  POLYMARKET_DATA_API_URL?: string;
  POLYMARKET_API_KEY?: string;
  POLYMARKET_API_SECRET?: string;
  POLYMARKET_API_PASSPHRASE?: string;
  POLYMARKET_ADDRESS?: string;
  POLYMARKET_CHAIN_ID?: string;
  POLYMARKET_SIGNATURE_TYPE?: string;
  POLYMARKET_REQUEST_TIMEOUT_MS?: string;
  POLYMARKET_MAX_REQUESTS_PER_SECOND?: string;
  POLYMARKET_MAX_RETRIES?: string;
  POLYMARKET_SYMBOL_MAP_JSON?: string;
  POLYMARKET_ORDER_SIGNER_URL?: string;
  POLYMARKET_ORDER_SIGNER_TIMEOUT_MS?: string;
  POLYMARKET_ORDER_SIGNER_BEARER_TOKEN?: string;

  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  XAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  CLOUDFLARE_AI_GATEWAY_TOKEN?: string;
  LLM_PROVIDER?: "openai-raw" | "ai-sdk" | "cloudflare-gateway";
  LLM_MODEL?: string;
  X_BEARER_TOKEN?: string;
  TWITTER_BEARER_TOKEN?: string;
  DISCORD_WEBHOOK_URL?: string;
  ALERTS_ENABLED?: string;
  ALERT_CHANNELS?: string;
  ALERT_WEBHOOK_URL?: string;
  ALERT_DEDUPE_WINDOW_SECONDS?: string;
  ALERT_RATE_LIMIT_MAX_PER_WINDOW?: string;
  ALERT_RATE_LIMIT_WINDOW_SECONDS?: string;
  ALERT_DLQ_WARN_THRESHOLD?: string;
  ALERT_DLQ_CRITICAL_THRESHOLD?: string;
  ALERT_LLM_AUTH_WINDOW_SECONDS?: string;
  ALERT_DRAWDOWN_WARN_RATIO?: string;
  STOCKTWITS_API_TOKEN?: string;
  ALPHA_VANTAGE_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  OWOKX_API_TOKEN: string;
  OWOKX_API_TOKEN_ADMIN?: string;
  OWOKX_API_TOKEN_TRADE?: string;
  OWOKX_API_TOKEN_READONLY?: string;
  APPROVAL_SIGNING_SECRET?: string;
  KILL_SWITCH_SECRET: string;
  KILL_SWITCH_ACTIVE?: string;

  ENVIRONMENT: string;
  SWARM_ALLOW_UNHEALTHY?: string;
  SWARM_ALLOW_DEGRADED?: string;
  SWARM_HEALTH_BYPASS?: string;
  FEATURE_LLM_RESEARCH: string;
  FEATURE_OPTIONS: string;

  DEFAULT_MAX_POSITION_PCT: string;
  DEFAULT_MAX_NOTIONAL_PER_TRADE: string;
  DEFAULT_MAX_SYMBOL_EXPOSURE_PCT?: string;
  DEFAULT_MAX_CORRELATED_EXPOSURE_PCT?: string;
  DEFAULT_MAX_PORTFOLIO_DRAWDOWN_PCT?: string;
  DEFAULT_MAX_DAILY_LOSS_PCT: string;
  DEFAULT_COOLDOWN_MINUTES: string;
  DEFAULT_MAX_OPEN_POSITIONS: string;
  DEFAULT_APPROVAL_TTL_SECONDS: string;
}

declare module "cloudflare:workers" {
  interface Env extends Env { }
}
