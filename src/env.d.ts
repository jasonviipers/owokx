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

  BROKER_PROVIDER?: "alpaca" | "okx";

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
  STOCKTWITS_API_TOKEN?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  OWOKX_API_TOKEN: string;
  OWOKX_API_TOKEN_ADMIN?: string;
  OWOKX_API_TOKEN_TRADE?: string;
  OWOKX_API_TOKEN_READONLY?: string;
  APPROVAL_SIGNING_SECRET?: string;
  KILL_SWITCH_SECRET: string;

  ENVIRONMENT: string;
  FEATURE_LLM_RESEARCH: string;
  FEATURE_OPTIONS: string;

  DEFAULT_MAX_POSITION_PCT: string;
  DEFAULT_MAX_NOTIONAL_PER_TRADE: string;
  DEFAULT_MAX_DAILY_LOSS_PCT: string;
  DEFAULT_COOLDOWN_MINUTES: string;
  DEFAULT_MAX_OPEN_POSITIONS: string;
  DEFAULT_APPROVAL_TTL_SECONDS: string;
}

declare module "cloudflare:workers" {
  interface Env extends Env { }
}
