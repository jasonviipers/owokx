/**
 * OwokxHarness - Autonomous Trading Agent Durable Object
 *
 * A fully autonomous trading agent that runs 24/7 on Cloudflare Workers.
 * This is the "harness" - customize it to match your trading strategy.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW TO CUSTOMIZE THIS AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. CONFIGURATION (AgentConfig & DEFAULT_CONFIG)
 *    - Tune risk parameters, position sizes, thresholds
 *    - Enable/disable features (options, crypto, staleness)
 *    - Set LLM models and token limits
 *
 * 2. DATA SOURCES (runDataGatherers, gatherStockTwits, gatherReddit, etc.)
 *    - Add new data sources (news APIs, alternative data)
 *    - Modify scraping logic and sentiment analysis
 *    - Adjust source weights in SOURCE_CONFIG
 *
 * 3. TRADING LOGIC (runAnalyst, executeBuy, executeSell)
 *    - Change entry/exit rules
 *    - Modify position sizing formulas
 *    - Add custom indicators
 *
 * 4. LLM PROMPTS (researchSignal, runPreMarketAnalysis)
 *    - Customize how the AI analyzes signals
 *    - Change research criteria and output format
 *
 * 5. NOTIFICATIONS (sendDiscordNotification)
 *    - Set DISCORD_WEBHOOK_URL secret to enable
 *    - Modify what triggers notifications
 *
 * Deploy with: wrangler deploy -c wrangler.v2.toml
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.d";
import { isRequestAuthorized } from "../lib/auth";
import { ErrorCode } from "../lib/errors";
import {
  buildPortfolioSnapshots,
  downsampleEquityPoints,
  periodWindowMs,
  timeframeBucketMs,
} from "../lib/portfolio-history";
import { createTelemetry, type TelemetryTags } from "../lib/telemetry";
import { getDefaultPolicyConfig } from "../policy/config";
import { type BrokerProviders, createBrokerProviders } from "../providers/broker-factory";
import { createLLMProvider } from "../providers/llm/factory";
import type { Account, LLMProvider, MarketClock, Position, Snapshot } from "../providers/types";
import { safeValidateAgentConfig } from "../schemas/agent-config";
import { createD1Client } from "../storage/d1/client";
import { createDecision } from "../storage/d1/queries/decisions";
import { getPolicyConfig, savePolicyConfig } from "../storage/d1/queries/policy-config";
import { getRiskState } from "../storage/d1/queries/risk-state";
import { createHarnessContext } from "./harness/context";
import { createExecutionService, type ExecutionService } from "./harness/execution-service";
import { createResearchService, type ResearchService } from "./harness/research-service";
import { createSignalService, type SignalService } from "./harness/signal-service";
import type { HarnessContext } from "./harness/types";

// ============================================================================
// SECTION 1: TYPES & CONFIGURATION
// ============================================================================
// [CUSTOMIZABLE] Modify these interfaces to add new fields for custom data sources.
// [CUSTOMIZABLE] AgentConfig contains ALL tunable parameters - start here!
// ============================================================================

interface AgentConfig {
  // Polling intervals - how often the agent checks for new data
  data_poll_interval_ms: number; // [TUNE] Default: 30s. Lower = more API calls
  analyst_interval_ms: number; // [TUNE] Default: 120s. How often to run trading logic

  broker: "alpaca" | "okx";

  // Position limits - risk management basics
  max_position_value: number; // [TUNE] Max $ per position
  max_positions: number; // [TUNE] Max concurrent positions
  min_sentiment_score: number; // [TUNE] Min sentiment to consider buying (0-1)
  min_analyst_confidence: number; // [TUNE] Min LLM confidence to execute (0-1)

  // Risk management - take profit and stop loss
  take_profit_pct: number; // [TUNE] Take profit at this % gain
  stop_loss_pct: number; // [TUNE] Stop loss at this % loss
  position_size_pct_of_cash: number; // [TUNE] % of cash per trade
  max_symbol_exposure_pct: number; // [TUNE] Max total symbol exposure as % of equity
  max_correlated_exposure_pct: number; // [TUNE] Max correlated bucket exposure as % of equity
  max_portfolio_drawdown_pct: number; // [TUNE] Max portfolio drawdown from session baseline

  // Stale position management - exit positions that have lost momentum
  stale_position_enabled: boolean;
  stale_min_hold_hours: number; // [TUNE] Min hours before checking staleness
  stale_max_hold_days: number; // [TUNE] Force exit after this many days
  stale_min_gain_pct: number; // [TUNE] Required gain % to hold past max days
  stale_mid_hold_days: number;
  stale_mid_min_gain_pct: number;
  stale_social_volume_decay: number; // [TUNE] Exit if volume drops to this % of entry

  // LLM configuration
  llm_provider: "openai-raw" | "ai-sdk" | "cloudflare-gateway"; // [TUNE] Provider: openai-raw, ai-sdk, cloudflare-gateway
  llm_model: string; // [TUNE] Model for quick research (gpt-4o-mini)
  llm_analyst_model: string; // [TUNE] Model for deep analysis (gpt-4o)
  llm_min_hold_minutes: number; // [TUNE] Min minutes before LLM can recommend sell (default: 30)
  starting_equity?: number;

  // Options trading - trade options instead of shares for high-conviction plays
  options_enabled: boolean; // [TOGGLE] Enable/disable options trading
  options_min_confidence: number; // [TUNE] Higher threshold for options (riskier)
  options_max_pct_per_trade: number;
  options_min_dte: number; // [TUNE] Minimum days to expiration
  options_max_dte: number; // [TUNE] Maximum days to expiration
  options_target_delta: number; // [TUNE] Target delta (0.3-0.5 typical)
  options_min_delta: number;
  options_max_delta: number;
  options_stop_loss_pct: number; // [TUNE] Options stop loss (wider than stocks)
  options_take_profit_pct: number; // [TUNE] Options take profit (higher targets)

  // Crypto trading - 24/7 momentum-based crypto trading
  crypto_enabled: boolean; // [TOGGLE] Enable/disable crypto trading
  crypto_symbols: string[]; // [TUNE] Which cryptos to trade (BTC/USD, etc.)
  crypto_momentum_threshold: number; // [TUNE] Min % move to trigger signal
  crypto_max_position_value: number;
  crypto_take_profit_pct: number;
  crypto_stop_loss_pct: number;

  // Custom ticker blacklist - user-defined symbols to never trade (e.g., insider trading restrictions)
  ticker_blacklist: string[];

  // Allowed exchanges - only trade stocks listed on these exchanges (avoids OTC data issues)
  allowed_exchanges: string[];

  // Dev escape hatch - lets local runs continue when swarm quorum is degraded.
  allow_unhealthy_swarm?: boolean;

  // Champion/challenger promotion thresholds for LearningAgent.
  strategy_promotion_enabled: boolean;
  strategy_promotion_min_samples: number;
  strategy_promotion_min_win_rate: number;
  strategy_promotion_min_avg_pnl: number;
  strategy_promotion_min_win_rate_lift: number;
}

// [CUSTOMIZABLE] Add fields here when you add new data sources
interface Signal {
  symbol: string;
  source: string; // e.g., "stocktwits", "reddit", "crypto", "your_source"
  source_detail: string; // e.g., "reddit_wallstreetbets"
  sentiment: number; // Weighted sentiment (-1 to 1)
  raw_sentiment: number; // Raw sentiment before weighting
  volume: number; // Number of mentions/messages
  freshness: number; // Time decay factor (0-1)
  source_weight: number; // How much to trust this source
  reason: string; // Human-readable reason
  timestamp: number; // Unix timestamp (ms) when signal was gathered
  upvotes?: number;
  comments?: number;
  quality_score?: number;
  subreddits?: string[];
  best_flair?: string | null;
  bullish?: number;
  bearish?: number;
  isCrypto?: boolean;
  momentum?: number;
  price?: number;
}

interface PositionEntry {
  symbol: string;
  entry_time: number;
  entry_price: number;
  entry_sentiment: number;
  entry_social_volume: number;
  entry_sources: string[];
  entry_reason: string;
  peak_price: number;
  peak_sentiment: number;
  entry_prediction?: number;
  entry_regime?: "trending" | "ranging" | "volatile";
}

interface SocialHistoryEntry {
  timestamp: number;
  volume: number;
  sentiment: number;
}

type ActivityEventType = "agent" | "trade" | "crypto" | "research" | "system" | "swarm" | "risk" | "data" | "api";
type ActivitySeverity = "debug" | "info" | "warning" | "error" | "critical";
type ActivityStatus = "info" | "started" | "in_progress" | "success" | "warning" | "failed" | "skipped";

interface LogEntry {
  id: string;
  timestamp: string;
  timestamp_ms: number;
  agent: string;
  action: string;
  event_type: ActivityEventType;
  severity: ActivitySeverity;
  status: ActivityStatus;
  description: string;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

interface CostTracker {
  total_usd: number;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

interface ResearchResult {
  symbol: string;
  verdict: "BUY" | "SKIP" | "WAIT";
  confidence: number;
  sentiment: number;
  entry_quality: "excellent" | "good" | "fair" | "poor";
  reasoning: string;
  red_flags: string[];
  catalysts: string[];
  timestamp: number;
}

interface ResearchLLMAnalysis {
  verdict: "BUY" | "SKIP" | "WAIT";
  confidence: number;
  entry_quality: "excellent" | "good" | "fair" | "poor";
  reasoning: string;
  red_flags: string[];
  catalysts: string[];
}

interface ModelParseFailure {
  stage: "research_signal" | "research_crypto";
  symbol: string;
  parser: "json" | "json-recovery";
  parseError: string | null;
  responsePreview: string;
  recoveryApplied: boolean;
  fallbackVerdict: "BUY" | "SKIP" | "WAIT";
}

interface TwitterConfirmation {
  symbol: string;
  tweet_count: number;
  sentiment: number;
  confirms_existing: boolean;
  highlights: Array<{ author: string; text: string; likes: number }>;
  timestamp: number;
}

interface PremarketPlan {
  timestamp: number;
  recommendations: Array<{
    action: "BUY" | "SELL" | "HOLD";
    symbol: string;
    confidence: number;
    reasoning: string;
    suggested_size_pct?: number;
  }>;
  market_summary: string;
  high_conviction: string[];
  researched_buys: ResearchResult[];
}

interface MemoryEpisode {
  id: string;
  timestamp: number;
  importance: number; // 0-1
  context: string;
  outcome: "success" | "failure" | "neutral";
  tags: string[];
  metadata?: Record<string, unknown>;
}

interface DynamicRiskProfile {
  timestamp: number;
  marketRegime: "trending" | "ranging" | "volatile";
  realizedVolatility: number;
  maxDrawdownPct: number;
  sharpeLike: number;
  multiplier: number;
  suggestedPositionPct: number;
}

interface MarketRegime {
  type: "trending" | "ranging" | "volatile";
  confidence: number;
  duration: number;
  characteristics: Record<string, number>;
  detectedAt: number;
  since: number;
}

interface PortfolioRiskDashboard {
  timestamp: number;
  regime: "trending" | "ranging" | "volatile";
  realizedVolatility: number;
  maxDrawdownPct: number;
  sharpeLike: number;
  valueAtRisk95Pct: number;
  expectedShortfall95Pct: number;
  grossExposureUsd: number;
  netExposureUsd: number;
  leverage: number;
  largestPositionPct: number;
  concentrationTop3Pct: number;
}

interface SignalQualityMetrics {
  timestamp: number;
  totalSignals: number;
  uniqueSymbols: number;
  outlierCount: number;
  averageCorrelation: number;
  maxCorrelation: number;
  highCorrelationPairs: Array<{ left: string; right: string; correlation: number }>;
  filteredSymbols: string[];
}

interface SignalPerformanceAttribution {
  timestamp: number;
  totalSamples: number;
  hitRate: number;
  avgReturnPct: number;
  topSymbols: Array<{ symbol: string; samples: number; winRate: number; avgReturnPct: number }>;
  laggingSymbols: Array<{ symbol: string; samples: number; winRate: number; avgReturnPct: number }>;
  factorAttribution: Array<{ factor: string; contribution: number }>;
}

interface PredictiveModelState {
  bias: number;
  learningRate: number;
  weights: {
    sentiment: number;
    freshness: number;
    sourceDiversity: number;
    logVolume: number;
    regimeAlignment: number;
  };
  samples: number;
  hitRate: number;
  mse: number;
  lastUpdatedAt: number;
  perSymbol: Record<
    string,
    {
      samples: number;
      wins: number;
      losses: number;
      avgReturnPct: number;
      lastOutcomeAt: number;
    }
  >;
}

interface StressTestResult {
  timestamp: number;
  passed: boolean;
  worstCaseLoss: number;
  worstCaseDrawdownPct: number;
  recommendedRiskMultiplier: number;
  historicalShockPct: number;
  scenarios: Array<{
    name: string;
    shockPct: number;
    projectedLoss: number;
    projectedDrawdownPct: number;
  }>;
}

interface OptimizationState {
  adaptiveDataPollIntervalMs: number;
  adaptiveResearchIntervalMs: number;
  adaptiveAnalystIntervalMs: number;
  gatherLatencyEmaMs: number;
  researchLatencyEmaMs: number;
  analystLatencyEmaMs: number;
  errorRateEma: number;
  lastOptimizationAt: number;
  optimizationRuns: number;
}

interface SymbolToolContext {
  technical: {
    rsi14: number | null;
    macd: number | null;
    macdSignal: number | null;
    bollingerUpper: number | null;
    bollingerMid: number | null;
    bollingerLower: number | null;
    trendStrength: number | null;
  };
  fundamental: {
    dailyChangePct: number;
    sourceDiversity: number;
    secCatalysts: number;
    mentionVolume: number;
  };
  risk: {
    portfolioVolatility: number;
    maxDrawdownPct: number;
    regime: "trending" | "ranging" | "volatile";
  };
}

interface AgentState {
  config: AgentConfig;
  signalCache: Signal[];
  signalCacheBytesEstimate: number;
  signalCachePeakBytes: number;
  signalCacheCleanupCount: number;
  signalCacheLastCleanupAt: number;
  positionEntries: Record<string, PositionEntry>;
  socialHistory: Record<string, SocialHistoryEntry[]>;
  logs: LogEntry[];
  costTracker: CostTracker;
  portfolioEquityHistory: Array<{ timestamp_ms: number; equity: number }>;
  lastPortfolioSnapshotAt: number;
  lastDataGatherRun: number;
  lastAnalystRun: number;
  lastResearchRun: number;
  signalResearch: Record<string, ResearchResult>;
  positionResearch: Record<string, unknown>;
  stalenessAnalysis: Record<string, unknown>;
  twitterConfirmations: Record<string, TwitterConfirmation>;
  twitterDailyReads: number;
  twitterDailyReadReset: number;
  twitterReadTokens: number;
  twitterReadLastRefill: number;
  memoryEpisodes: MemoryEpisode[];
  lastRiskProfile: DynamicRiskProfile | null;
  marketRegime: MarketRegime;
  predictiveModel: PredictiveModelState;
  lastStressTest: StressTestResult | null;
  optimization: OptimizationState;
  lastSwarmRoleSyncAt: number;
  swarmRoleHealth: Partial<Record<"scout" | "analyst" | "trader" | "risk_manager" | "learning", number>>;
  premarketPlan: PremarketPlan | null;
  lastBrokerAuthError?: { at: number; message: string };
  lastLLMAuthError?: { at: number; message: string };
  enabled: boolean;
  overnightActivity?: {
    signalsGathered: number;
    signalsResearched: number;
    buySignals: number;
    twitterConfirmations: number;
    premarketPlanReady: boolean;
    lastUpdated: number;
  };
}

// ============================================================================
// [CUSTOMIZABLE] SOURCE_CONFIG - How much to trust each data source
// ============================================================================
const SOURCE_CONFIG = {
  weights: {
    stocktwits: 0.85,
    reddit_wallstreetbets: 0.6,
    reddit_stocks: 0.9,
    reddit_investing: 0.8,
    reddit_options: 0.85,
    twitter_fintwit: 0.95,
    twitter_news: 0.9,
    sec_8k: 0.95,
    sec_4: 0.9,
    sec_13f: 0.7,
  },
  // [TUNE] Reddit flair multipliers - boost/penalize based on post type
  flairMultipliers: {
    DD: 1.5, // Due Diligence - high value
    "Technical Analysis": 1.3,
    Fundamentals: 1.3,
    News: 1.2,
    Discussion: 1.0,
    Chart: 1.1,
    "Daily Discussion": 0.7, // Low signal
    "Weekend Discussion": 0.6,
    YOLO: 0.6, // Entertainment, not alpha
    Gain: 0.5, // Loss porn - inverse signal?
    Loss: 0.5,
    Meme: 0.4,
    Shitpost: 0.3,
  } as Record<string, number>,
  // [TUNE] Engagement multipliers - more engagement = more trusted
  engagement: {
    upvotes: { 1000: 1.5, 500: 1.3, 200: 1.2, 100: 1.1, 50: 1.0, 0: 0.8 } as Record<number, number>,
    comments: { 200: 1.4, 100: 1.25, 50: 1.15, 20: 1.05, 0: 0.9 } as Record<number, number>,
  },
  // [TUNE] How fast old posts lose weight (minutes). Lower = faster decay.
  decayHalfLifeMinutes: 120,
};

const DEFAULT_CONFIG: AgentConfig = {
  data_poll_interval_ms: 30_000,
  analyst_interval_ms: 120_000,
  broker: "alpaca",
  max_position_value: 5000,
  max_positions: 5,
  min_sentiment_score: 0.3,
  min_analyst_confidence: 0.6,
  take_profit_pct: 10,
  stop_loss_pct: 5,
  position_size_pct_of_cash: 25,
  max_symbol_exposure_pct: 0.25,
  max_correlated_exposure_pct: 0.5,
  max_portfolio_drawdown_pct: 0.15,
  stale_position_enabled: true,
  stale_min_hold_hours: 24,
  stale_max_hold_days: 3,
  stale_min_gain_pct: 5,
  stale_mid_hold_days: 2,
  stale_mid_min_gain_pct: 3,
  stale_social_volume_decay: 0.3,
  llm_provider: "openai-raw",
  llm_model: "gpt-4o-mini",
  llm_analyst_model: "gpt-4o",
  llm_min_hold_minutes: 30,
  options_enabled: false,
  options_min_confidence: 0.8,
  options_max_pct_per_trade: 0.02,
  options_min_dte: 30,
  options_max_dte: 60,
  options_target_delta: 0.45,
  options_min_delta: 0.3,
  options_max_delta: 0.7,
  options_stop_loss_pct: 50,
  options_take_profit_pct: 100,
  crypto_enabled: true,
  crypto_symbols: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
  crypto_momentum_threshold: 2.0,
  crypto_max_position_value: 1000,
  crypto_take_profit_pct: 10,
  crypto_stop_loss_pct: 5,
  ticker_blacklist: [],
  allowed_exchanges: ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"],
  allow_unhealthy_swarm: false,
  strategy_promotion_enabled: false,
  strategy_promotion_min_samples: 30,
  strategy_promotion_min_win_rate: 0.55,
  strategy_promotion_min_avg_pnl: 5,
  strategy_promotion_min_win_rate_lift: 0.03,
};

type GathererSource = "stocktwits" | "reddit" | "crypto" | "sec" | "scout";

const SIGNAL_CACHE_MAX = 200;
const SIGNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SIGNAL_CACHE_MEMORY_BUDGET_BYTES = 5 * 1024 * 1024; // 5MB soft cap for persisted signal cache
const SIGNAL_CACHE_EMERGENCY_MIN = 80;

const DATA_GATHERER_TIMEOUT_MS: Record<GathererSource, number> = {
  stocktwits: 6_000,
  reddit: 12_000,
  crypto: 4_000,
  sec: 5_000,
  scout: 4_000,
};

const RESEARCH_MAX_CONCURRENT = 3;
const RESEARCH_BATCH_DELAY_MS = 200;

const MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_MAX_EPISODES = 500;
const MEMORY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MEMORY_MIN_IMPORTANCE_TO_KEEP = 0.15;

const SWARM_ROLE_SYNC_INTERVAL_MS = 120_000;
const STRESS_TEST_INTERVAL_MS = 300_000;
const OPTIMIZATION_INTERVAL_MS = 180_000;
const LOG_RETENTION_MAX = 1_000;
const LOG_FLUSH_INTERVAL_MS = 2_000;
const PERSIST_RETRY_LOG_LIMITS = [700, 400, 200, 100] as const;
const PERSIST_RETRY_MEMORY_LIMITS = [300, 200, 120, 80] as const;
const PERSIST_RETRY_PORTFOLIO_LIMITS = [2_500, 1_500, 900, 500] as const;
const PERSIST_RETRY_SIGNAL_CACHE_LIMITS = [160, 120, 90, 60] as const;

const TWITTER_DAILY_READ_LIMIT = 200;
const TWITTER_BUCKET_CAPACITY = 20;
const TWITTER_BUCKET_REFILL_PER_SECOND = TWITTER_DAILY_READ_LIMIT / 86_400;
const TWITTER_BUCKET_DAY_MS = 86_400_000;

const DEFAULT_MARKET_REGIME: MarketRegime = {
  type: "ranging",
  confidence: 0.5,
  duration: 0,
  characteristics: {
    volatility: 0.01,
    trend: 0,
    sharpe_like: 0,
    sentiment_dispersion: 0,
  },
  detectedAt: 0,
  since: 0,
};

const DEFAULT_PREDICTIVE_MODEL: PredictiveModelState = {
  bias: 0,
  learningRate: 0.05,
  weights: {
    sentiment: 1.2,
    freshness: 0.8,
    sourceDiversity: 0.5,
    logVolume: 0.35,
    regimeAlignment: 0.4,
  },
  samples: 0,
  hitRate: 0,
  mse: 0,
  lastUpdatedAt: 0,
  perSymbol: {},
};

const DEFAULT_OPTIMIZATION_STATE: OptimizationState = {
  adaptiveDataPollIntervalMs: DEFAULT_CONFIG.data_poll_interval_ms,
  adaptiveResearchIntervalMs: 120_000,
  adaptiveAnalystIntervalMs: DEFAULT_CONFIG.analyst_interval_ms,
  gatherLatencyEmaMs: 0,
  researchLatencyEmaMs: 0,
  analystLatencyEmaMs: 0,
  errorRateEma: 0,
  lastOptimizationAt: 0,
  optimizationRuns: 0,
};

const DEFAULT_STATE: AgentState = {
  config: DEFAULT_CONFIG,
  signalCache: [],
  signalCacheBytesEstimate: 0,
  signalCachePeakBytes: 0,
  signalCacheCleanupCount: 0,
  signalCacheLastCleanupAt: 0,
  positionEntries: {},
  socialHistory: {},
  logs: [],
  costTracker: { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 },
  portfolioEquityHistory: [],
  lastPortfolioSnapshotAt: 0,
  lastDataGatherRun: 0,
  lastAnalystRun: 0,
  lastResearchRun: 0,
  signalResearch: {},
  positionResearch: {},
  stalenessAnalysis: {},
  twitterConfirmations: {},
  twitterDailyReads: 0,
  twitterDailyReadReset: 0,
  twitterReadTokens: TWITTER_BUCKET_CAPACITY,
  twitterReadLastRefill: 0,
  memoryEpisodes: [],
  lastRiskProfile: null,
  marketRegime: { ...DEFAULT_MARKET_REGIME },
  predictiveModel: { ...DEFAULT_PREDICTIVE_MODEL, weights: { ...DEFAULT_PREDICTIVE_MODEL.weights }, perSymbol: {} },
  lastStressTest: null,
  optimization: { ...DEFAULT_OPTIMIZATION_STATE },
  lastSwarmRoleSyncAt: 0,
  swarmRoleHealth: {},
  premarketPlan: null,
  enabled: false,
};

// Blacklist for ticker extraction - common English words and trading slang
const TICKER_BLACKLIST = new Set([
  // Finance/trading terms
  "CEO",
  "CFO",
  "COO",
  "CTO",
  "IPO",
  "EPS",
  "GDP",
  "SEC",
  "FDA",
  "USA",
  "USD",
  "ETF",
  "NYSE",
  "API",
  "ATH",
  "ATL",
  "IMO",
  "FOMO",
  "YOLO",
  "DD",
  "TA",
  "FA",
  "ROI",
  "PE",
  "PB",
  "PS",
  "EV",
  "DCF",
  "WSB",
  "RIP",
  "LOL",
  "OMG",
  "WTF",
  "FUD",
  "HODL",
  "APE",
  "MOASS",
  "DRS",
  "NFT",
  "DAO",
  // Common English words (2-4 letters that look like tickers)
  "THE",
  "AND",
  "FOR",
  "ARE",
  "BUT",
  "NOT",
  "YOU",
  "ALL",
  "CAN",
  "HER",
  "WAS",
  "ONE",
  "OUR",
  "OUT",
  "DAY",
  "HAD",
  "HAS",
  "HIS",
  "HOW",
  "ITS",
  "LET",
  "MAY",
  "NEW",
  "NOW",
  "OLD",
  "SEE",
  "WAY",
  "WHO",
  "BOY",
  "DID",
  "GET",
  "HIM",
  "HIT",
  "LOW",
  "MAN",
  "RUN",
  "SAY",
  "SHE",
  "TOO",
  "USE",
  "DAD",
  "MOM",
  "GOT",
  "HAS",
  "HAD",
  "LET",
  "PUT",
  "SAW",
  "SAT",
  "SET",
  "SIT",
  "TRY",
  "THAT",
  "THIS",
  "WITH",
  "HAVE",
  "FROM",
  "THEY",
  "BEEN",
  "CALL",
  "WILL",
  "EACH",
  "MAKE",
  "LIKE",
  "TIME",
  "JUST",
  "KNOW",
  "TAKE",
  "COME",
  "MADE",
  "FIND",
  "MORE",
  "LONG",
  "HERE",
  "MANY",
  "SOME",
  "THAN",
  "THEM",
  "THEN",
  "ONLY",
  "OVER",
  "SUCH",
  "YEAR",
  "INTO",
  "MOST",
  "ALSO",
  "BACK",
  "GOOD",
  "WELL",
  "EVEN",
  "WANT",
  "GIVE",
  "MUCH",
  "WORK",
  "FIRST",
  "AFTER",
  "AS",
  "AT",
  "BE",
  "BY",
  "DO",
  "GO",
  "IF",
  "IN",
  "IS",
  "IT",
  "MY",
  "NO",
  "OF",
  "ON",
  "OR",
  "SO",
  "TO",
  "UP",
  "US",
  "WE",
  "AN",
  "AM",
  "AH",
  "OH",
  "OK",
  "HI",
  "YA",
  "YO",
  // More trading slang
  "BULL",
  "BEAR",
  "CALL",
  "PUTS",
  "HOLD",
  "SELL",
  "MOON",
  "PUMP",
  "DUMP",
  "BAGS",
  "TEND",
  // Additional common words that appear as false positives
  "START",
  "ABOUT",
  "NAME",
  "NEXT",
  "PLAY",
  "LIVE",
  "GAME",
  "BEST",
  "LINK",
  "READ",
  "POST",
  "NEWS",
  "FREE",
  "LOOK",
  "HELP",
  "OPEN",
  "FULL",
  "VIEW",
  "REAL",
  "SEND",
  "HIGH",
  "DROP",
  "FAST",
  "SAFE",
  "RISK",
  "TURN",
  "PLAN",
  "DEAL",
  "MOVE",
  "HUGE",
  "EASY",
  "HARD",
  "LATE",
  "WAIT",
  "SOON",
  "STOP",
  "EXIT",
  "GAIN",
  "LOSS",
  "GROW",
  "FALL",
  "JUMP",
  "KEEP",
  "COPY",
  "EDIT",
  "SAVE",
  "NOTE",
  "TIPS",
  "IDEA",
  "PLUS",
  "ZERO",
  "SELF",
  "BOTH",
  "BETA",
  "TEST",
  "INFO",
  "DATA",
  "CASH",
  "WHAT",
  "WHEN",
  "WHERE",
  "WHY",
  "WATCH",
  "LOVE",
  "HATE",
  "TECH",
  "HOPE",
  "FEAR",
  "WEEK",
  "LAST",
  "PART",
  "SIDE",
  "STEP",
  "SURE",
  "TELL",
  "THINK",
  "TOLD",
  "TRUE",
  "TURN",
  "TYPE",
  "UNIT",
  "USED",
  "VERY",
  "WANT",
  "WENT",
  "WERE",
  "YEAH",
  "YOUR",
  "ELSE",
  "AWAY",
  "OTHER",
  "PRICE",
  "THEIR",
  "STILL",
  "CHEAP",
  "THESE",
  "LEAP",
  "EVERY",
  "SINCE",
  "BEING",
  "THOSE",
  "DOING",
  "COULD",
  "WOULD",
  "SHOULD",
  "MIGHT",
  "MUST",
  "SHALL",
]);

class ValidTickerCache {
  private secTickers: Set<string> | null = null;
  private lastSecRefresh = 0;
  private alpacaCache: Map<string, boolean> = new Map();
  private readonly SEC_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  async refreshSecTickersIfNeeded(): Promise<void> {
    if (this.secTickers && Date.now() - this.lastSecRefresh < this.SEC_REFRESH_INTERVAL_MS) {
      return;
    }
    try {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": "Owokx Trading Bot" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
      this.secTickers = new Set(Object.values(data).map((e) => e.ticker.toUpperCase()));
      this.lastSecRefresh = Date.now();
    } catch {
      // Keep existing cache on failure
    }
  }

  isKnownSecTicker(symbol: string): boolean {
    return this.secTickers?.has(symbol.toUpperCase()) ?? false;
  }

  getCachedValidation(symbol: string): boolean | undefined {
    return this.alpacaCache.get(symbol.toUpperCase());
  }

  setCachedValidation(symbol: string, isValid: boolean): void {
    this.alpacaCache.set(symbol.toUpperCase(), isValid);
  }

  async validateWithBroker(
    symbol: string,
    broker: { trading: { getAsset(s: string): Promise<{ tradable: boolean } | null> } }
  ): Promise<boolean> {
    const upper = symbol.toUpperCase();
    const cached = this.alpacaCache.get(upper);
    if (cached !== undefined) return cached;

    try {
      const asset = await broker.trading.getAsset(upper);
      const isValid = asset !== null && asset.tradable;
      this.alpacaCache.set(upper, isValid);
      return isValid;
    } catch {
      this.alpacaCache.set(upper, false);
      return false;
    }
  }
}

const tickerCache = new ValidTickerCache();

// ============================================================================
// SECTION 2: HELPER FUNCTIONS
// ============================================================================
// [CUSTOMIZABLE] These utilities calculate sentiment weights and extract tickers.
// Modify these to change how posts are scored and filtered.
// ============================================================================

function normalizeCryptoSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();

  if (upper.includes("/")) {
    return upper;
  }

  const dashed = upper.match(/^([A-Z0-9]{2,15})-(USD|USDT|USDC)$/);
  if (dashed) {
    return `${dashed[1]}/${dashed[2]}`;
  }

  const alias = upper.match(/^([A-Z0-9]{2,15})(?:[.\-_]?X)$/);
  if (alias) {
    return `${alias[1]}/USDT`;
  }

  const match = upper.match(/^([A-Z0-9]{2,15})(USD|USDT|USDC)$/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }

  return upper;
}

function isCryptoSymbol(symbol: string, cryptoSymbols: string[]): boolean {
  const normalizedInput = normalizeCryptoSymbol(symbol);
  for (const configSymbol of cryptoSymbols) {
    if (normalizeCryptoSymbol(configSymbol) === normalizedInput) {
      return true;
    }
  }
  return /^[A-Z]{2,5}\/(USD|USDT|USDC)$/.test(normalizedInput);
}

/**
 * [TUNE] Time decay - how quickly old posts lose weight
 * Uses exponential decay with half-life from SOURCE_CONFIG.decayHalfLifeMinutes
 * Modify the min/max clamp values (0.2-1.0) to change bounds
 */
function calculateTimeDecay(postTimestamp: number): number {
  const ageMinutes = (Date.now() - postTimestamp * 1000) / 60000;
  const halfLife = SOURCE_CONFIG.decayHalfLifeMinutes;
  const decay = 0.5 ** (ageMinutes / halfLife);
  return Math.max(0.2, Math.min(1.0, decay));
}

function getEngagementMultiplier(upvotes: number, comments: number): number {
  let upvoteMultiplier = 0.8;
  const upvoteThresholds = Object.entries(SOURCE_CONFIG.engagement.upvotes).sort(([a], [b]) => Number(b) - Number(a));
  for (const [threshold, mult] of upvoteThresholds) {
    if (upvotes >= parseInt(threshold, 10)) {
      upvoteMultiplier = mult;
      break;
    }
  }

  let commentMultiplier = 0.9;
  const commentThresholds = Object.entries(SOURCE_CONFIG.engagement.comments).sort(([a], [b]) => Number(b) - Number(a));
  for (const [threshold, mult] of commentThresholds) {
    if (comments >= parseInt(threshold, 10)) {
      commentMultiplier = mult;
      break;
    }
  }

  return (upvoteMultiplier + commentMultiplier) / 2;
}

/** [TUNE] Flair multiplier - boost/penalize based on Reddit post flair */
function getFlairMultiplier(flair: string | null | undefined): number {
  if (!flair) return 1.0;
  return SOURCE_CONFIG.flairMultipliers[flair.trim()] || 1.0;
}

/**
 * [CUSTOMIZABLE] Ticker extraction - modify regex to change what counts as a ticker
 * Current: $SYMBOL or SYMBOL followed by trading keywords
 * Add patterns for your data sources (e.g., cashtags, mentions)
 */
function extractTickers(text: string, customBlacklist: string[] = []): string[] {
  const matches = new Set<string>();
  const customSet = new Set(customBlacklist.map((t) => t.toUpperCase()));
  const regex =
    /\$([A-Z]{1,5})\b|\b([A-Z]{2,5})\b(?=\s+(?:calls?|puts?|stock|shares?|moon|rocket|yolo|buy|sell|long|short))/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const ticker = (match[1] || match[2] || "").toUpperCase();
    if (ticker.length >= 2 && ticker.length <= 5 && !TICKER_BLACKLIST.has(ticker) && !customSet.has(ticker)) {
      matches.add(ticker);
    }
  }
  return Array.from(matches);
}

/**
 * [CUSTOMIZABLE] Sentiment detection - keyword-based bullish/bearish scoring
 * Add/remove words to match your trading style
 * Returns -1 (bearish) to +1 (bullish)
 */
function detectSentiment(text: string): number {
  const lower = text.toLowerCase();
  const bullish = [
    "moon",
    "rocket",
    "buy",
    "calls",
    "long",
    "bullish",
    "yolo",
    "tendies",
    "gains",
    "diamond",
    "squeeze",
    "pump",
    "green",
    "up",
    "breakout",
    "undervalued",
    "accumulate",
  ];
  const bearish = [
    "puts",
    "short",
    "sell",
    "bearish",
    "crash",
    "dump",
    "drill",
    "tank",
    "rip",
    "red",
    "down",
    "bag",
    "overvalued",
    "bubble",
    "avoid",
  ];

  let bull = 0,
    bear = 0;
  for (const w of bullish) if (lower.includes(w)) bull++;
  for (const w of bearish) if (lower.includes(w)) bear++;

  const total = bull + bear;
  if (total === 0) return 0;
  return (bull - bear) / total;
}

// ============================================================================
// SECTION 3: DURABLE OBJECT CLASS
// ============================================================================
// The main agent class. Modify alarm() to change the core loop.
// Add new HTTP endpoints in fetch() for custom dashboard controls.
// ============================================================================

export class OwokxHarness extends DurableObject<Env> {
  private state: AgentState = { ...DEFAULT_STATE };
  private _llm: LLMProvider | null = null;
  private readonly telemetry = createTelemetry("owokx_harness");
  private readonly harnessContext: HarnessContext<AgentState>;
  private readonly signalService: SignalService;
  private readonly researchService: ResearchService<ResearchResult>;
  private readonly executionService: ExecutionService;
  private lastLogPersistAt = 0;
  private logPersistTimerArmed = false;
  private lastSwarmBypassLogAt = 0;
  private lastLearningPromotionSyncAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.harnessContext = createHarnessContext({
      env: this.env,
      getState: () => this.state,
      getLLM: () => this._llm,
    });
    this.signalService = createSignalService(this.harnessContext, {
      runDataGatherers: () => this.runDataGatherers(),
    });
    this.researchService = createResearchService<ResearchResult>(this.harnessContext, {
      researchTopSignals: (limit?: number) => this.researchTopSignals(limit),
    });
    this.executionService = createExecutionService(this.harnessContext);

    this._llm = createLLMProvider(env);
    if (this._llm) {
      console.log(
        JSON.stringify({
          provider: "agent",
          agent: "OwokxHarness",
          event: "llm_initialized",
          llm_provider: env.LLM_PROVIDER || "openai-raw",
          llm_model: env.LLM_MODEL || "gpt-4o-mini",
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      console.log(
        JSON.stringify({
          provider: "agent",
          agent: "OwokxHarness",
          event: "llm_unconfigured",
          severity: "warning",
          message: "No valid LLM provider configured - research disabled",
          timestamp: new Date().toISOString(),
        })
      );
    }

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<AgentState>("state");
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
        this.state.config = {
          ...DEFAULT_CONFIG,
          ...(stored.config ?? {}),
        };
        if (!Array.isArray(this.state.memoryEpisodes)) {
          this.state.memoryEpisodes = [];
        }
        this.state.marketRegime = {
          ...DEFAULT_MARKET_REGIME,
          ...(this.state.marketRegime ?? {}),
          characteristics: {
            ...DEFAULT_MARKET_REGIME.characteristics,
            ...(this.state.marketRegime?.characteristics ?? {}),
          },
        };
        this.state.predictiveModel = {
          ...DEFAULT_PREDICTIVE_MODEL,
          ...(this.state.predictiveModel ?? {}),
          weights: {
            ...DEFAULT_PREDICTIVE_MODEL.weights,
            ...(this.state.predictiveModel?.weights ?? {}),
          },
          perSymbol: this.state.predictiveModel?.perSymbol ?? {},
        };
        this.state.optimization = {
          ...DEFAULT_OPTIMIZATION_STATE,
          ...(this.state.optimization ?? {}),
        };
        if (!Array.isArray(this.state.logs)) {
          this.state.logs = [];
        } else {
          this.state.logs = this.state.logs
            .map((entry, index) => this.normalizeLogEntry(entry, index))
            .filter((entry): entry is LogEntry => entry !== null)
            .slice(-LOG_RETENTION_MAX);
        }
        this.ensureSignalResearchSentiment();
        this.pruneMemoryEpisodes();

        // AUTO-CORRECTION: Fix corrupted crypto_symbols in persisted state
        if (this.state.config.crypto_symbols && Array.isArray(this.state.config.crypto_symbols)) {
          const fixedSymbols = this.state.config.crypto_symbols.map((s) => {
            if (s.endsWith("USDTTT")) return s.replace("USDTTT", "USDT");
            if (s.endsWith("USDTT")) return s.replace("USDTT", "USDT");
            return s;
          });

          // If changes were made, save them immediately
          if (JSON.stringify(fixedSymbols) !== JSON.stringify(this.state.config.crypto_symbols)) {
            this.state.config.crypto_symbols = fixedSymbols;
            console.log("[OwokxHarness] Fixed corrupted crypto_symbols in state:", fixedSymbols);
            await this.persist();
          }
        }
      }
      if (this.enforceProductionSwarmGuard()) {
        await this.persist();
      }
      this.initializeLLM();

      // Reschedule alarm if stale - in local dev, past alarms don't fire on restart;
      // in production this is a defensive check for edge cases (long inactivity, redeployments)
      if (this.state.enabled) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        const now = Date.now();
        if (!existingAlarm || existingAlarm < now) {
          await this.ctx.storage.setAlarm(now + 5_000);
        }
      }
    });
  }

  private initializeLLM() {
    const provider = this.state.config.llm_provider || this.env.LLM_PROVIDER || "openai-raw";
    const model = this.state.config.llm_model || this.env.LLM_MODEL || "gpt-4o-mini";

    const effectiveEnv: Env = {
      ...this.env,
      LLM_PROVIDER: provider as Env["LLM_PROVIDER"],
      LLM_MODEL: model,
    };

    this._llm = createLLMProvider(effectiveEnv);
    if (this._llm) {
      console.log(
        JSON.stringify({
          provider: "agent",
          agent: "OwokxHarness",
          event: "llm_initialized",
          llm_provider: provider,
          llm_model: model,
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      console.log(
        JSON.stringify({
          provider: "agent",
          agent: "OwokxHarness",
          event: "llm_unconfigured",
          severity: "warning",
          message: "No valid LLM provider configured",
          timestamp: new Date().toISOString(),
        })
      );
    }
  }

  // ============================================================================
  // [CUSTOMIZABLE] ALARM HANDLER - Main entry point for scheduled work
  // ============================================================================
  // This runs every 30 seconds. Modify to change:
  // - What runs and when (intervals, market hours checks)
  // - Order of operations (data → research → trading)
  // - Add new features (e.g., portfolio rebalancing, alerts)
  // ============================================================================

  // ============================================================================
  // HELPERS FOR NEW CHECKS
  // ============================================================================

  private async checkKillSwitch(): Promise<boolean> {
    if (!this.state.enabled) return true;

    if (this.env.KILL_SWITCH_ACTIVE === "true") return true;

    if (this.env.RISK_MANAGER) {
      try {
        const id = this.env.RISK_MANAGER.idFromName("default");
        const stub = this.env.RISK_MANAGER.get(id);
        const res = await stub.fetch("http://risk/status");
        if (res.ok) {
          const data = (await res.json()) as { killSwitchActive: boolean };
          if (data.killSwitchActive) {
            this.log("System", "kill_switch_from_risk_manager", {
              reason: "RiskManager kill switch is active",
            });
            return true;
          }
        }
      } catch (e) {
        this.log("System", "kill_switch_check_failed", {
          error: String(e),
          action: "blocking_trading_as_precaution",
        });
        return true;
      }
    }

    return false;
  }

  private async checkSwarmHealth(): Promise<boolean> {
    if (!this.env.SWARM_REGISTRY) {
      // Standalone mode: assume healthy if no registry binding is configured
      return true;
    }

    try {
      const id = this.env.SWARM_REGISTRY.idFromName("default");
      const stub = this.env.SWARM_REGISTRY.get(id);

      const res = await stub.fetch("http://registry/health");
      if (res.ok) {
        const data = (await res.json()) as { healthy: boolean };
        return data.healthy;
      }

      this.log("System", "swarm_health_check_failed", { status: res.status });
      return false;
    } catch (e) {
      this.log("System", "swarm_health_check_error", { error: String(e) });
      return false;
    }
  }

  private isProductionEnvironment(): boolean {
    return this.env.ENVIRONMENT.toLowerCase() === "production";
  }

  private enforceProductionSwarmGuard(): boolean {
    if (!this.isProductionEnvironment()) {
      return false;
    }

    if (this.state.config.allow_unhealthy_swarm !== true) {
      return false;
    }

    this.state.config.allow_unhealthy_swarm = false;
    this.log("System", "config_guard_enforced", {
      field: "allow_unhealthy_swarm",
      reason: "allow_unhealthy_swarm cannot be true in production",
      severity: "warning",
      status: "warning",
      event_type: "api",
    });
    return true;
  }

  private isSwarmHealthBypassEnabled(): boolean {
    if (this.isProductionEnvironment()) {
      return false;
    }

    if (this.state.config.allow_unhealthy_swarm === true) {
      return true;
    }

    const envBypass =
      this.env.SWARM_ALLOW_UNHEALTHY === "true" ||
      this.env.SWARM_ALLOW_DEGRADED === "true" ||
      this.env.SWARM_HEALTH_BYPASS === "true";
    if (!envBypass) {
      return false;
    }

    return true;
  }

  private getConfiguredCryptoSymbolsNormalized(): Set<string> {
    return new Set((this.state.config.crypto_symbols || []).map((symbol) => normalizeCryptoSymbol(symbol)));
  }

  private normalizeResearchSymbolForBroker(symbol: string, broker: BrokerProviders["broker"]): string | null {
    const trimmed = symbol.trim();
    if (trimmed.length === 0) return null;

    if (broker === "alpaca") {
      // Social feeds often emit crypto aliases like BTC.X/ETH.X that are not Alpaca equities.
      if (/[.\-_]X$/i.test(trimmed)) {
        return null;
      }
      return trimmed;
    }

    const configured = this.getConfiguredCryptoSymbolsNormalized();
    if (configured.size === 0) {
      return null;
    }

    const upper = trimmed.toUpperCase();
    const slashCandidate = normalizeCryptoSymbol(upper.replace("-", "/"));
    if (configured.has(slashCandidate)) {
      return slashCandidate;
    }

    // StockTwits/Reddit crypto tickers are frequently emitted as BTC.X/ETH.X etc.
    const suffixMatch = upper.match(/^([A-Z0-9]{2,10})(?:[.\-_]?X)$/);
    const bareMatch = upper.match(/^([A-Z0-9]{2,10})$/);
    const inferredBase = suffixMatch?.[1] ?? bareMatch?.[1];
    if (!inferredBase) {
      return null;
    }

    for (const configuredSymbol of configured) {
      if (configuredSymbol.startsWith(`${inferredBase}/`)) {
        return configuredSymbol;
      }
    }

    return null;
  }

  private validateMarketData(snapshot: Snapshot | null): boolean {
    if (!snapshot) return false;
    const isCrypto = isCryptoSymbol(snapshot.symbol, this.state.config.crypto_symbols || []);
    // Equities should be near-real-time. Crypto on OKX demo/public feeds can be slightly delayed.
    const MAX_AGE_MS = isCrypto ? 10 * 60_000 : 10_000;
    const dataTimestamp = snapshot.latest_trade?.timestamp
      ? new Date(snapshot.latest_trade.timestamp).getTime()
      : Date.now();
    if (Date.now() - dataTimestamp > MAX_AGE_MS) {
      this.log("System", "stale_market_data", { symbol: snapshot.symbol, age_ms: Date.now() - dataTimestamp });
      return false;
    }
    return true;
  }

  async alarm(): Promise<void> {
    const alarmTags: TelemetryTags = { loop: "main" };
    this.telemetry.increment("alarm_runs_total", 1, alarmTags);
    const stopAlarmTimer = this.telemetry.startTimer("alarm_latency_ms", alarmTags);

    if (!this.state.enabled) {
      this.telemetry.increment("alarm_skipped_total", 1, { reason: "disabled" });
      this.log("System", "alarm_skipped", { reason: "Agent not enabled" });
      await this.persist();
      stopAlarmTimer();
      return;
    }

    const now = Date.now();
    const researchIntervalMs =
      this.state.optimization?.adaptiveResearchIntervalMs || DEFAULT_OPTIMIZATION_STATE.adaptiveResearchIntervalMs;
    const dataPollIntervalMs =
      this.state.optimization?.adaptiveDataPollIntervalMs || this.state.config.data_poll_interval_ms;
    const analystIntervalMs =
      this.state.optimization?.adaptiveAnalystIntervalMs || this.state.config.analyst_interval_ms;
    const POSITION_RESEARCH_INTERVAL_MS = 300_000;

    try {
      // 1. Check Kill Switch (Task 3)
      const isKillSwitchActive = await this.checkKillSwitch();
      if (isKillSwitchActive) {
        this.telemetry.increment("alarm_skipped_total", 1, { reason: "kill_switch" });
        this.log("System", "alarm_skipped", { reason: "Kill switch active" });
        return;
      }

      // 2. Check Swarm Health (Task 1)
      const isSwarmHealthy = await this.checkSwarmHealth();
      if (!isSwarmHealthy) {
        if (this.isSwarmHealthBypassEnabled()) {
          const nowMs = Date.now();
          if (nowMs - this.lastSwarmBypassLogAt >= 300_000) {
            this.log("System", "swarm_health_bypass_active", {
              reason: "Swarm unhealthy (quorum not met)",
              status: "warning",
              event_type: "swarm",
            });
            this.lastSwarmBypassLogAt = nowMs;
          }
        } else {
          this.telemetry.increment("alarm_skipped_total", 1, { reason: "swarm_unhealthy" });
          this.log("System", "alarm_skipped", { reason: "Swarm unhealthy (quorum not met)" });
          return;
        }
      }

      if (now - this.state.lastSwarmRoleSyncAt >= SWARM_ROLE_SYNC_INTERVAL_MS) {
        await this.syncSwarmRoleHealth();
      }

      await this.syncLearningPromotionThresholds();

      const broker = createBrokerProviders(this.env, this.state.config.broker);
      const clock = await broker.trading.getClock();

      if (now - this.state.lastDataGatherRun >= dataPollIntervalMs) {
        const stopStage = this.telemetry.startTimer("alarm_stage_latency_ms", { stage: "data_gather" });
        try {
          await this.signalService.runDataGatherers();
        } finally {
          stopStage();
        }
        this.state.lastDataGatherRun = now;
      }

      if (now - this.state.lastResearchRun >= researchIntervalMs) {
        const stopStage = this.telemetry.startTimer("alarm_stage_latency_ms", { stage: "research" });
        try {
          await this.researchService.researchTopSignals(5);
        } finally {
          stopStage();
        }
        this.state.lastResearchRun = now;
      }

      if (this.isPreMarketWindow(broker.broker, clock) && !this.state.premarketPlan) {
        await this.runPreMarketAnalysis();
      }

      const positions = await broker.trading.getPositions();
      if (!this.state.lastStressTest || now - this.state.lastStressTest.timestamp >= STRESS_TEST_INTERVAL_MS) {
        try {
          const account = await broker.trading.getAccount();
          this.runStressTest(account, positions);
        } catch (error) {
          this.log("Risk", "stress_test_skipped", { error: String(error) });
          this.recordPerformanceSample("analyst", 0, true);
        }
      }

      if (this.state.config.crypto_enabled) {
        await this.runCryptoTrading(broker, positions);
      }

      if (clock.is_open) {
        if (this.isMarketJustOpened(broker.broker, clock) && this.state.premarketPlan) {
          await this.executePremarketPlan();
        }

        if (now - this.state.lastAnalystRun >= analystIntervalMs) {
          const analystStart = Date.now();
          const stopStage = this.telemetry.startTimer("alarm_stage_latency_ms", { stage: "analyst" });
          try {
            await this.runAnalyst();
          } finally {
            stopStage();
          }
          this.recordPerformanceSample("analyst", Date.now() - analystStart, false);
          this.state.lastAnalystRun = now;
        }

        if (positions.length > 0 && now - this.state.lastResearchRun >= POSITION_RESEARCH_INTERVAL_MS) {
          for (const pos of positions) {
            if (pos.asset_class !== "us_option") {
              await this.researchPosition(pos.symbol, pos);
            }
          }
        }

        if (this.isOptionsEnabled()) {
          const optionsExits = await this.checkOptionsExits(positions);
          for (const exit of optionsExits) {
            await this.executeSell(broker, exit.symbol, exit.reason);
          }
        }

        if (this.isTwitterEnabled()) {
          const heldSymbols = positions.map((p) => p.symbol);
          const breakingNews = await this.checkTwitterBreakingNews(heldSymbols);
          for (const news of breakingNews) {
            if (news.is_breaking) {
              this.log("System", "twitter_breaking_news", {
                symbol: news.symbol,
                headline: news.headline.slice(0, 100),
              });
            }
          }
        }
      }

      if (
        !this.state.optimization.lastOptimizationAt ||
        now - this.state.optimization.lastOptimizationAt >= OPTIMIZATION_INTERVAL_MS
      ) {
        this.optimizeRuntimeParameters(now);
      }
    } catch (error) {
      this.log("System", "alarm_error", { error: String(error) });
      this.telemetry.increment("alarm_errors_total", 1, { stage: "main" });
      this.recordPerformanceSample("analyst", this.state.optimization.analystLatencyEmaMs || 1_000, true);
    } finally {
      this.pruneMemoryEpisodes();
      await this.persist();
      await this.scheduleNextAlarm();
      stopAlarmTimer();
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextRun = Date.now() + 30_000; // 30 seconds
    await this.ctx.storage.setAlarm(nextRun);
  }

  // ============================================================================
  // HTTP HANDLER (for dashboard/control)
  // ============================================================================
  // Add new endpoints here for custom dashboard controls.
  // Example: /webhook for external alerts, /backtest for simulation
  // ============================================================================

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }

  private isAuthorized(request: Request, scope: "read" | "trade"): boolean {
    return isRequestAuthorized(request, this.env, scope);
  }

  private isKillSwitchAuthorized(request: Request): boolean {
    const secret = this.env.KILL_SWITCH_SECRET;
    if (!secret) {
      return false;
    }
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return false;
    }
    return this.constantTimeCompare(authHeader.slice(7), secret);
  }

  private unauthorizedResponse(): Response {
    return new Response(JSON.stringify({ error: "Unauthorized. Requires: Authorization: Bearer <OWOKX_API_TOKEN>" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1) || "root";
    const telemetryTags: TelemetryTags = {
      action,
      method: request.method.toUpperCase(),
    };
    this.telemetry.increment("http_requests_total", 1, telemetryTags);
    const stopRequestTimer = this.telemetry.startTimer("http_request_latency_ms", telemetryTags);

    const readActions = [
      "status",
      "logs",
      "costs",
      "signals",
      "history",
      "metrics",
      "regime",
      "prediction",
      "stress-test",
    ];
    const tradeActions = ["enable", "disable", "trigger", "reset"];
    let requiredScope: "read" | "trade" | null = null;

    if (readActions.includes(action)) {
      requiredScope = "read";
    } else if (tradeActions.includes(action)) {
      requiredScope = "trade";
    } else if (action === "config") {
      requiredScope = request.method === "POST" ? "trade" : "read";
    }

    let response: Response;
    try {
      if (requiredScope && !this.isAuthorized(request, requiredScope)) {
        response = this.unauthorizedResponse();
      } else {
        response = await this.handleActionRequest(action, request, url);
      }
    } catch (error) {
      response = new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = response.status;
    this.telemetry.increment("http_responses_total", 1, { ...telemetryTags, status });
    if (status >= 400) {
      this.telemetry.increment("http_errors_total", 1, { ...telemetryTags, status });
    }
    stopRequestTimer();

    return response;
  }

  private async handleActionRequest(action: string, request: Request, url: URL): Promise<Response> {
    switch (action) {
      case "status":
        return this.handleStatus();

      case "setup/status":
        return this.handleSetupStatus(request);

      case "config":
        if (request.method === "POST") {
          return this.handleUpdateConfig(request);
        }
        return this.jsonResponse({ ok: true, data: this.state.config });

      case "enable":
        return this.handleEnable();

      case "disable":
        return this.handleDisable();

      case "reset":
        return this.handleReset();

      case "logs":
        return this.handleGetLogs(url);

      case "costs":
        return this.jsonResponse({ costs: this.state.costTracker });

      case "signals":
        return this.jsonResponse({ signals: this.state.signalCache });

      case "history":
        return this.handleGetHistory(url);

      case "metrics":
        return this.handleMetrics();

      case "regime":
        return this.jsonResponse({ regime: this.state.marketRegime, risk_profile: this.state.lastRiskProfile });

      case "prediction":
        return this.jsonResponse({
          predictive_model: this.state.predictiveModel,
          top_symbol_stats: Object.entries(this.state.predictiveModel.perSymbol)
            .sort((a, b) => (b[1]?.samples || 0) - (a[1]?.samples || 0))
            .slice(0, 20)
            .reduce<Record<string, unknown>>((acc, [symbol, stats]) => {
              acc[symbol] = stats;
              return acc;
            }, {}),
        });

      case "stress-test":
        return this.handleStressTest();

      case "trigger":
        await this.alarm();
        return this.jsonResponse({ ok: true, message: "Alarm triggered" });

      case "kill":
        if (!this.isKillSwitchAuthorized(request)) {
          return new Response(
            JSON.stringify({ error: "Forbidden. Requires: Authorization: Bearer <KILL_SWITCH_SECRET>" }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        return this.handleKillSwitch();

      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private resolvePublicApiOrigin(request: Request): string {
    const fromProxy = request.headers.get("x-owokx-public-origin");
    if (fromProxy) {
      try {
        return new URL(fromProxy).origin;
      } catch {
        // fall through
      }
    }

    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
    if (forwardedHost) {
      try {
        return new URL(`${forwardedProto}://${forwardedHost}`).origin;
      } catch {
        // fall through
      }
    }

    const host = request.headers.get("host");
    if (host && host !== "harness") {
      const local = host.includes("localhost") || host.startsWith("127.") || host.startsWith("0.0.0.0");
      try {
        return new URL(`${local ? "http" : "https"}://${host}`).origin;
      } catch {
        // fall through
      }
    }

    return "http://127.0.0.1:8787";
  }

  private handleSetupStatus(request: Request): Response {
    const apiOrigin = this.resolvePublicApiOrigin(request);
    const tokenEnvVar = "OWOKX_TOKEN";
    const tokenSecretName = "OWOKX_API_TOKEN";

    return this.jsonResponse({
      ok: true,
      data: {
        configured: true,
        api_origin: apiOrigin,
        auth: {
          header: "Authorization",
          scheme: "Bearer",
          token_env_var: tokenEnvVar,
          token_secret_name: tokenSecretName,
        },
        commands: {
          enable: {
            method: "GET",
            path: "/agent/enable",
            curl: `curl -H "Authorization: Bearer $${tokenEnvVar}" ${apiOrigin}/agent/enable`,
          },
          disable: {
            method: "GET",
            path: "/agent/disable",
            curl: `curl -H "Authorization: Bearer $${tokenEnvVar}" ${apiOrigin}/agent/disable`,
          },
          trigger: {
            method: "POST",
            path: "/agent/trigger",
            curl: `curl -X POST -H "Authorization: Bearer $${tokenEnvVar}" ${apiOrigin}/agent/trigger`,
          },
        },
      },
    });
  }

  private handleMetrics(): Response {
    const now = Date.now();
    const recentLogs = this.state.logs.slice(-100);
    const recentErrors = recentLogs.filter((l) => l.action.includes("error") || l.action.includes("failed")).length;
    const signals = Array.isArray(this.state.signalCache) ? this.state.signalCache.length : 0;
    const positionEntries = this.state.positionEntries ? Object.keys(this.state.positionEntries).length : 0;
    const elapsedSeconds = Math.max(0, (now - (this.state.twitterReadLastRefill || now)) / 1000);
    const projectedTwitterTokens = Math.min(
      TWITTER_BUCKET_CAPACITY,
      this.state.twitterReadTokens + elapsedSeconds * TWITTER_BUCKET_REFILL_PER_SECOND
    );

    return this.jsonResponse({
      ok: true,
      data: {
        enabled: this.state.enabled,
        environment: this.env.ENVIRONMENT,
        costs: this.state.costTracker,
        llm: {
          configured: !!this._llm,
          provider: this.state.config.llm_provider,
          model: this.state.config.llm_model,
          last_auth_error: this.state.lastLLMAuthError ?? null,
        },
        signals,
        position_entries: positionEntries,
        logs_total: this.state.logs.length,
        logs_recent_errors: recentErrors,
        last_analyst_run_ms: this.state.lastAnalystRun ?? null,
        last_research_run_ms: this.state.lastResearchRun ?? null,
        signal_cache_bytes_estimate: this.state.signalCacheBytesEstimate,
        signal_cache_peak_bytes: this.state.signalCachePeakBytes,
        signal_cache_cleanup_count: this.state.signalCacheCleanupCount,
        signal_cache_last_cleanup_at: this.state.signalCacheLastCleanupAt || null,
        twitter_daily_reads: this.state.twitterDailyReads,
        twitter_daily_remaining: Math.max(0, TWITTER_DAILY_READ_LIMIT - this.state.twitterDailyReads),
        twitter_bucket_tokens: Number(projectedTwitterTokens.toFixed(3)),
        memory_episodes: this.state.memoryEpisodes.length,
        last_risk_profile: this.state.lastRiskProfile,
        market_regime: this.state.marketRegime,
        last_stress_test: this.state.lastStressTest,
        optimization: this.state.optimization,
        predictive_model_samples: this.state.predictiveModel.samples,
        predictive_model_hit_rate: this.state.predictiveModel.hitRate,
        swarm_role_health: this.state.swarmRoleHealth,
        swarm_role_sync_at: this.state.lastSwarmRoleSyncAt || null,
        now_ms: now,
        telemetry: this.telemetry.snapshot(),
      },
    });
  }

  private async handleStressTest(): Promise<Response> {
    let broker: BrokerProviders;
    try {
      broker = createBrokerProviders(this.env, this.state.config.broker);
    } catch (error) {
      return this.jsonResponse({ ok: false, error: String(error) });
    }

    try {
      const [account, positions] = await Promise.all([broker.trading.getAccount(), broker.trading.getPositions()]);
      const report = this.runStressTest(account, positions);
      return this.jsonResponse({ ok: true, report });
    } catch (error) {
      return this.jsonResponse({ ok: false, error: String(error) });
    }
  }

  private maybeRecordPortfolioSnapshot(equity: number): void {
    const now = Date.now();
    const minIntervalMs = 60_000;
    if (now - this.state.lastPortfolioSnapshotAt < minIntervalMs) return;

    this.state.lastPortfolioSnapshotAt = now;
    this.state.portfolioEquityHistory.push({ timestamp_ms: now, equity });

    const cutoffMs = now - 35 * 24 * 60 * 60 * 1000;
    this.state.portfolioEquityHistory = this.state.portfolioEquityHistory
      .filter((p) => p.timestamp_ms >= cutoffMs)
      .slice(-5000);

    this.ctx.waitUntil(this.persist());
  }

  private async handleStatus(): Promise<Response> {
    const heldSymbolsFromState = new Set(Object.keys(this.state.positionEntries || {}));
    const signalQualityFromState = this.buildSignalQualityMetrics(heldSymbolsFromState);
    const signalPerformance = this.buildSignalPerformanceAttribution();

    let broker: BrokerProviders;
    try {
      broker = createBrokerProviders(this.env, this.state.config.broker);
    } catch (error) {
      this.log("System", "broker_unconfigured", { error: String(error) });
      return this.jsonResponse({
        ok: false,
        error: String(error),
        data: {
          enabled: this.state.enabled,
          account: null,
          positions: [],
          clock: null,
          config: this.state.config,
          signals: this.state.signalCache,
          logs: this.state.logs.slice(-300),
          costs: this.state.costTracker,
          llm: {
            configured: !!this._llm,
            provider: this.state.config.llm_provider,
            model: this.state.config.llm_model,
            last_auth_error: this.state.lastLLMAuthError ?? null,
          },
          lastAnalystRun: this.state.lastAnalystRun,
          lastResearchRun: this.state.lastResearchRun,
          signalResearch: this.state.signalResearch,
          positionResearch: this.state.positionResearch,
          positionEntries: this.state.positionEntries,
          twitterConfirmations: this.state.twitterConfirmations,
          premarketPlan: this.state.premarketPlan,
          stalenessAnalysis: this.state.stalenessAnalysis,
          memoryEpisodes: this.state.memoryEpisodes.slice(-50),
          lastRiskProfile: this.state.lastRiskProfile,
          marketRegime: this.state.marketRegime,
          predictiveModel: this.state.predictiveModel,
          lastStressTest: this.state.lastStressTest,
          optimization: this.state.optimization,
          swarmRoleHealth: this.state.swarmRoleHealth,
          portfolioRisk: null,
          signalQuality: signalQualityFromState,
          signalPerformance,
        },
      });
    }

    let account: Account | null = null;
    let positions: Position[] = [];
    let clock: MarketClock | null = null;

    const cachedAuthError = this.state.lastBrokerAuthError;
    if (cachedAuthError && Date.now() - cachedAuthError.at < 60_000) {
      return this.jsonResponse({
        ok: true,
        data: {
          enabled: this.state.enabled,
          account,
          positions,
          clock,
          config: this.state.config,
          signals: this.state.signalCache,
          logs: this.state.logs.slice(-300),
          costs: this.state.costTracker,
          llm: {
            configured: !!this._llm,
            provider: this.state.config.llm_provider,
            model: this.state.config.llm_model,
            last_auth_error: this.state.lastLLMAuthError ?? null,
          },
          lastAnalystRun: this.state.lastAnalystRun,
          lastResearchRun: this.state.lastResearchRun,
          signalResearch: this.state.signalResearch,
          positionResearch: this.state.positionResearch,
          positionEntries: this.state.positionEntries,
          twitterConfirmations: this.state.twitterConfirmations,
          premarketPlan: this.state.premarketPlan,
          stalenessAnalysis: this.state.stalenessAnalysis,
          memoryEpisodes: this.state.memoryEpisodes.slice(-50),
          lastRiskProfile: this.state.lastRiskProfile,
          marketRegime: this.state.marketRegime,
          predictiveModel: this.state.predictiveModel,
          lastStressTest: this.state.lastStressTest,
          optimization: this.state.optimization,
          swarmRoleHealth: this.state.swarmRoleHealth,
          portfolioRisk: null,
          signalQuality: signalQualityFromState,
          signalPerformance,
          broker_error: cachedAuthError.message,
        },
      });
    }

    try {
      [account, positions, clock] = await Promise.all([
        broker.trading.getAccount(),
        broker.trading.getPositions(),
        broker.trading.getClock(),
      ]);
      this.state.lastBrokerAuthError = undefined;
      if (account) {
        this.maybeRecordPortfolioSnapshot(account.equity);
      }

      for (const pos of positions || []) {
        const entry = this.state.positionEntries[pos.symbol];
        if (entry && entry.entry_price === 0 && pos.avg_entry_price) {
          entry.entry_price = pos.avg_entry_price;
          entry.peak_price = Math.max(entry.peak_price, pos.current_price);
        }
      }
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === ErrorCode.UNAUTHORIZED || code === ErrorCode.FORBIDDEN) {
        this.state.lastBrokerAuthError = { at: Date.now(), message: String(error) };
      }
    }

    let swarm: any;
    if (this.env.SWARM_REGISTRY) {
      try {
        const id = this.env.SWARM_REGISTRY.idFromName("default");
        const stub = this.env.SWARM_REGISTRY.get(id);
        const [healthRes, agentsRes] = await Promise.all([
          stub.fetch("http://registry/health"),
          stub.fetch("http://registry/agents"),
        ]);
        if (healthRes.ok && agentsRes.ok) {
          const health = (await healthRes.json()) as { healthy: boolean; active_agents: number };
          const agents = (await agentsRes.json()) as Record<string, any>;
          swarm = { ...health, agents };
        }
      } catch (_e) {
        // ignore
      }
    }

    const heldSymbols = new Set(positions.map((position) => position.symbol));
    const signalQuality = this.buildSignalQualityMetrics(heldSymbols);
    const portfolioRisk = this.buildPortfolioRiskDashboard(account, positions);

    return this.jsonResponse({
      ok: true,
      data: {
        enabled: this.state.enabled,
        account,
        positions,
        clock,
        config: this.state.config,
        signals: this.state.signalCache,
        logs: this.state.logs.slice(-300),
        costs: this.state.costTracker,
        llm: {
          configured: !!this._llm,
          provider: this.state.config.llm_provider,
          model: this.state.config.llm_model,
          last_auth_error: this.state.lastLLMAuthError ?? null,
        },
        lastAnalystRun: this.state.lastAnalystRun,
        lastResearchRun: this.state.lastResearchRun,
        signalResearch: this.state.signalResearch,
        positionResearch: this.state.positionResearch,
        positionEntries: this.state.positionEntries,
        twitterConfirmations: this.state.twitterConfirmations,
        premarketPlan: this.state.premarketPlan,
        stalenessAnalysis: this.state.stalenessAnalysis,
        overnightActivity: this.state.overnightActivity,
        memoryEpisodes: this.state.memoryEpisodes.slice(-50),
        lastRiskProfile: this.state.lastRiskProfile,
        marketRegime: this.state.marketRegime,
        predictiveModel: this.state.predictiveModel,
        lastStressTest: this.state.lastStressTest,
        optimization: this.state.optimization,
        swarmRoleHealth: this.state.swarmRoleHealth,
        portfolioRisk,
        signalQuality,
        signalPerformance,
        swarm,
      },
    });
  }

  private async handleUpdateConfig(request: Request): Promise<Response> {
    let body: Partial<AgentConfig> & { broker?: string };
    try {
      body = (await request.json()) as Partial<AgentConfig>;
    } catch (error) {
      this.log("System", "config_update_invalid_json", {
        error: String(error),
        status: "failed",
        event_type: "api",
      });
      return new Response(
        JSON.stringify(
          {
            ok: false,
            error: "Invalid JSON payload for /agent/config",
          },
          null,
          2
        ),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    const changedKeys = Object.keys(body);

    if (typeof body.broker === "string") {
      const normalizedBroker = body.broker.trim().toLowerCase();
      if (normalizedBroker !== "alpaca" && normalizedBroker !== "okx") {
        this.log("System", "config_update_rejected", {
          field: "broker",
          reason: "broker must be 'alpaca' or 'okx'",
          attempted_value: body.broker,
          changed_keys: changedKeys,
          severity: "error",
          status: "failed",
          event_type: "api",
        });
        return new Response(
          JSON.stringify(
            {
              ok: false,
              error: "broker must be one of: alpaca, okx",
            },
            null,
            2
          ),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      body.broker = normalizedBroker;
    }

    if (this.isProductionEnvironment() && body.allow_unhealthy_swarm === true) {
      this.log("System", "config_update_rejected", {
        field: "allow_unhealthy_swarm",
        reason: "allow_unhealthy_swarm cannot be true in production",
        attempted_value: true,
        changed_keys: changedKeys,
        severity: "error",
        status: "failed",
        event_type: "api",
      });
      await this.persist();
      return new Response(
        JSON.stringify(
          {
            ok: false,
            error: "allow_unhealthy_swarm cannot be enabled in production",
          },
          null,
          2
        ),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const candidateConfig = { ...this.state.config, ...body };
    const parsedConfig = safeValidateAgentConfig(candidateConfig);
    if (!parsedConfig.success) {
      this.log("System", "config_update_rejected", {
        reason: "schema_validation_failed",
        changed_keys: changedKeys,
        validation_errors: parsedConfig.error.flatten(),
        severity: "error",
        status: "failed",
        event_type: "api",
      });
      return new Response(
        JSON.stringify(
          {
            ok: false,
            error: "Invalid configuration payload",
            details: parsedConfig.error.flatten(),
          },
          null,
          2
        ),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    this.state.config = parsedConfig.data;
    this.enforceProductionSwarmGuard();
    this.state.optimization.adaptiveDataPollIntervalMs = this.state.config.data_poll_interval_ms;
    this.state.optimization.adaptiveAnalystIntervalMs = this.state.config.analyst_interval_ms;

    try {
      const db = createD1Client(this.env.DB);
      const storedPolicy = (await getPolicyConfig(db)) ?? getDefaultPolicyConfig(this.env);
      await savePolicyConfig(db, {
        ...storedPolicy,
        max_symbol_exposure_pct: this.state.config.max_symbol_exposure_pct,
        max_correlated_exposure_pct: this.state.config.max_correlated_exposure_pct,
        max_portfolio_drawdown_pct: this.state.config.max_portfolio_drawdown_pct,
      });
    } catch (error) {
      this.log("System", "policy_sync_failed", {
        reason: "unable_to_persist_risk_fields",
        error: String(error),
        severity: "warning",
        status: "warning",
        event_type: "api",
      });
    }

    this.log("System", "config_updated", {
      changed_keys: changedKeys,
      change_count: changedKeys.length,
      status: "success",
      event_type: "api",
    });
    this.initializeLLM();
    await this.syncLearningPromotionThresholds(true);
    await this.persist();
    return this.jsonResponse({ ok: true, config: this.state.config });
  }

  private async syncLearningPromotionThresholds(force = false): Promise<void> {
    if (!this.env.LEARNING_AGENT) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastLearningPromotionSyncAt < 300_000) {
      return;
    }

    try {
      const learningId = this.env.LEARNING_AGENT.idFromName("default");
      const learningAgent = this.env.LEARNING_AGENT.get(learningId);
      const response = await learningAgent.fetch("http://learning/promotion/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: this.state.config.strategy_promotion_enabled,
          min_samples: this.state.config.strategy_promotion_min_samples,
          min_win_rate: this.state.config.strategy_promotion_min_win_rate,
          min_avg_pnl: this.state.config.strategy_promotion_min_avg_pnl,
          min_win_rate_lift: this.state.config.strategy_promotion_min_win_rate_lift,
        }),
      });

      if (!response.ok) {
        this.log("Learning", "promotion_threshold_sync_failed", {
          status: response.status,
          event_type: "swarm",
          severity: "warning",
          status_text: response.statusText,
        });
        return;
      }

      this.lastLearningPromotionSyncAt = now;
    } catch (error) {
      this.log("Learning", "promotion_threshold_sync_error", {
        error: String(error),
        event_type: "swarm",
        severity: "warning",
      });
    }
  }

  private async handleEnable(): Promise<Response> {
    this.state.enabled = true;
    await this.persist();
    await this.scheduleNextAlarm();
    this.log("System", "agent_enabled", {});
    return this.jsonResponse({ ok: true, enabled: true });
  }

  private async handleDisable(): Promise<Response> {
    this.state.enabled = false;
    await this.ctx.storage.deleteAlarm();
    await this.persist();
    this.log("System", "agent_disabled", {});
    return this.jsonResponse({ ok: true, enabled: false });
  }

  private async handleReset(): Promise<Response> {
    await this.ctx.storage.deleteAll();
    this.state = { ...DEFAULT_STATE };
    this.log("System", "agent_reset", { timestamp: new Date().toISOString() });
    await this.persist();
    return this.jsonResponse({
      ok: true,
      message: "Agent storage cleared and state reset to defaults.",
    });
  }

  private handleGetLogs(url: URL): Response {
    const parseSet = (key: string): Set<string> => {
      const values = url.searchParams
        .getAll(key)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0);
      return new Set(values);
    };

    const limitRaw = Number.parseInt(url.searchParams.get("limit") || "200", 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 2_000)) : 200;

    const sinceRaw = Number.parseInt(url.searchParams.get("since") || "", 10);
    const untilRaw = Number.parseInt(url.searchParams.get("until") || "", 10);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : null;
    const until = Number.isFinite(untilRaw) ? untilRaw : null;

    const eventTypes = parseSet("event_type");
    const severities = parseSet("severity");
    const statuses = parseSet("status");
    const agents = parseSet("agent");
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();

    let filtered = [...this.state.logs];
    if (since !== null) {
      filtered = filtered.filter((entry) => entry.timestamp_ms >= since);
    }
    if (until !== null) {
      filtered = filtered.filter((entry) => entry.timestamp_ms <= until);
    }
    if (eventTypes.size > 0) {
      filtered = filtered.filter((entry) => eventTypes.has(entry.event_type));
    }
    if (severities.size > 0) {
      filtered = filtered.filter((entry) => severities.has(entry.severity));
    }
    if (statuses.size > 0) {
      filtered = filtered.filter((entry) => statuses.has(entry.status));
    }
    if (agents.size > 0) {
      filtered = filtered.filter((entry) => agents.has(entry.agent.toLowerCase()));
    }
    if (search.length > 0) {
      filtered = filtered.filter((entry) => {
        const haystack =
          `${entry.agent} ${entry.action} ${entry.description} ${JSON.stringify(entry.metadata)}`.toLowerCase();
        return haystack.includes(search);
      });
    }

    const logs = filtered.sort((a, b) => b.timestamp_ms - a.timestamp_ms).slice(0, limit);
    return this.jsonResponse({
      ok: true,
      logs,
      total: this.state.logs.length,
      filtered: filtered.length,
      limit,
      available_event_types: ["agent", "trade", "crypto", "research", "system", "swarm", "risk", "data", "api"],
      available_severities: ["debug", "info", "warning", "error", "critical"],
      available_statuses: ["info", "started", "in_progress", "success", "warning", "failed", "skipped"],
    });
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    let broker: BrokerProviders;
    try {
      broker = createBrokerProviders(this.env, this.state.config.broker);
    } catch (error) {
      this.log("System", "history_broker_unconfigured", { error: String(error) });
      return this.jsonResponse({ ok: false, error: String(error) });
    }
    const period = url.searchParams.get("period") || "1M";
    const timeframe = url.searchParams.get("timeframe") || "1D";
    const intradayReporting = url.searchParams.get("intraday_reporting") as
      | "market_hours"
      | "extended_hours"
      | "continuous"
      | null;

    const cachedAuthError = this.state.lastBrokerAuthError;
    if (cachedAuthError && Date.now() - cachedAuthError.at < 60_000) {
      return this.jsonResponse({ ok: false, error: cachedAuthError.message });
    }

    try {
      const history = await broker.trading.getPortfolioHistory({
        period,
        timeframe,
        intraday_reporting: intradayReporting || "extended_hours",
      });
      this.state.lastBrokerAuthError = undefined;

      const hasTimeseries =
        Array.isArray(history.timestamp) &&
        Array.isArray(history.equity) &&
        history.timestamp.length > 1 &&
        history.equity.length > 1;

      if (!hasTimeseries) {
        const windowMs = periodWindowMs(period);
        const cutoffMs = windowMs ? Date.now() - windowMs : 0;
        const bucketMs = timeframeBucketMs(timeframe);
        const points = downsampleEquityPoints(
          this.state.portfolioEquityHistory.filter((p) => (cutoffMs ? p.timestamp_ms >= cutoffMs : true)),
          bucketMs
        );
        const nowMs = Date.now();
        const latestEquity = history.equity?.[history.equity.length - 1];
        const ensuredPoints =
          points.length > 0
            ? points.length > 1
              ? points
              : [...points, { timestamp_ms: nowMs, equity: points[0]!.equity }]
            : Number.isFinite(latestEquity)
              ? [
                  { timestamp_ms: nowMs - (bucketMs || 60_000), equity: latestEquity as number },
                  { timestamp_ms: nowMs, equity: latestEquity as number },
                ]
              : [];

        const baseValue = this.state.config.starting_equity ?? ensuredPoints[0]?.equity ?? 0;

        return this.jsonResponse({
          ok: true,
          data: {
            snapshots: buildPortfolioSnapshots(ensuredPoints, baseValue),
            base_value: baseValue,
            timeframe,
          },
        });
      }

      const snapshots = history.timestamp.map((ts, i) => ({
        timestamp: ts * 1000,
        equity: history.equity[i],
        pl: history.profit_loss[i],
        pl_pct: history.profit_loss_pct[i],
      }));

      return this.jsonResponse({
        ok: true,
        data: {
          snapshots,
          base_value: history.base_value,
          timeframe: history.timeframe,
        },
      });
    } catch (error) {
      this.log("System", "history_error", { error: String(error) });
      const code = (error as { code?: string } | null)?.code;
      if (code === ErrorCode.UNAUTHORIZED || code === ErrorCode.FORBIDDEN) {
        this.state.lastBrokerAuthError = { at: Date.now(), message: String(error) };
      }
      if (code !== ErrorCode.UNAUTHORIZED && code !== ErrorCode.FORBIDDEN) {
        const windowMs = periodWindowMs(period);
        const cutoffMs = windowMs ? Date.now() - windowMs : 0;
        const bucketMs = timeframeBucketMs(timeframe);
        const points = downsampleEquityPoints(
          this.state.portfolioEquityHistory.filter((p) => (cutoffMs ? p.timestamp_ms >= cutoffMs : true)),
          bucketMs
        );
        if (points.length > 1) {
          const baseValue = this.state.config.starting_equity ?? points[0]?.equity ?? 0;
          return this.jsonResponse({
            ok: true,
            data: {
              snapshots: buildPortfolioSnapshots(points, baseValue),
              base_value: baseValue,
              timeframe,
            },
          });
        }
      }
      return this.jsonResponse({ ok: false, error: String(error) });
    }
  }

  private async handleKillSwitch(): Promise<Response> {
    this.state.enabled = false;
    await this.ctx.storage.deleteAlarm();
    this.state.signalCache = [];
    this.state.signalResearch = {};
    this.state.premarketPlan = null;
    await this.persist();
    this.log("System", "kill_switch_activated", { timestamp: new Date().toISOString() });
    return this.jsonResponse({
      ok: true,
      message: "KILL SWITCH ACTIVATED. Agent disabled, alarms cancelled, signal cache cleared.",
      note: "Existing positions are NOT automatically closed. Review and close manually if needed.",
    });
  }

  // ============================================================================
  // SECTION 4: DATA GATHERING
  // ============================================================================
  // [CUSTOMIZABLE] This is where you add NEW DATA SOURCES.
  //
  // To add a new source:
  // 1. Create a new gather method (e.g., gatherNewsAPI)
  // 2. Add it to runDataGatherers() gatherers array (allSettled + timeout)
  // 3. Add source weight to SOURCE_CONFIG.weights
  // 4. Return Signal[] with your source name
  //
  // Each gatherer returns Signal[] which get merged into signalCache.
  // ============================================================================

  private async runDataGatherers(): Promise<void> {
    this.log("System", "gathering_data", {});
    const startedAt = Date.now();

    try {
      await this.withTimeout(tickerCache.refreshSecTickersIfNeeded(), 3_000, "sec_ticker_refresh_timeout");
    } catch (error) {
      this.log("System", "sec_ticker_refresh_failed", { error: String(error) });
    }

    const gatherers: Array<{ source: GathererSource; run: () => Promise<Signal[]> }> = [
      { source: "stocktwits", run: () => this.gatherStockTwits() },
      { source: "reddit", run: () => this.gatherReddit() },
      { source: "crypto", run: () => this.gatherCrypto() },
      { source: "sec", run: () => this.gatherSECFilings() },
    ];
    if (this.env.DATA_SCOUT) {
      gatherers.push({ source: "scout", run: () => this.gatherScoutSignals() });
    }

    const sourceCounts: Record<GathererSource, number> = {
      stocktwits: 0,
      reddit: 0,
      crypto: 0,
      sec: 0,
      scout: 0,
    };
    const sourceDurations: Partial<Record<GathererSource, number>> = {};

    const settled = await Promise.allSettled(
      gatherers.map(async (gatherer) => {
        const sourceStart = Date.now();
        const signals = await this.withTimeout(
          gatherer.run(),
          DATA_GATHERER_TIMEOUT_MS[gatherer.source],
          `${gatherer.source}_gather_timeout`
        );
        return {
          source: gatherer.source,
          signals,
          durationMs: Date.now() - sourceStart,
        };
      })
    );

    const allSignals: Signal[] = [];
    const failures: GathererSource[] = [];

    settled.forEach((result, index) => {
      const source = gatherers[index]!.source;
      if (result.status === "fulfilled") {
        sourceCounts[source] = result.value.signals.length;
        sourceDurations[source] = result.value.durationMs;
        allSignals.push(...result.value.signals);
        return;
      }

      failures.push(source);
      this.log("DataGather", "source_failed", { source, error: String(result.reason) });
    });

    this.updateSignalCache(allSignals);

    const gatherDurationMs = Date.now() - startedAt;
    this.log("System", "data_gathered", {
      stocktwits: sourceCounts.stocktwits,
      reddit: sourceCounts.reddit,
      crypto: sourceCounts.crypto,
      sec: sourceCounts.sec,
      scout: sourceCounts.scout,
      total: this.state.signalCache.length,
      gather_duration_ms: gatherDurationMs,
      source_durations_ms: sourceDurations,
      failed_sources: failures,
      signal_cache_bytes: this.state.signalCacheBytesEstimate,
    });
    this.recordPerformanceSample("gather", gatherDurationMs, failures.length > 0);

    this.rememberEpisode(
      `Data gathered with ${this.state.signalCache.length} active signals`,
      failures.length === gatherers.length ? "failure" : "success",
      ["data", "signals", ...Object.keys(sourceCounts)],
      {
        impact: Math.min(1, this.state.signalCache.length / Math.max(1, SIGNAL_CACHE_MAX)),
        confidence: failures.length > 0 ? 0.6 : 0.85,
        novelty: failures.length > 0 ? 0.75 : 0.4,
        metadata: {
          sourceCounts,
          failures,
          durationMs: gatherDurationMs,
        },
      }
    );
  }

  private updateSignalCache(incomingSignals: Signal[]): void {
    const now = Date.now();
    const existingSignals = Array.isArray(this.state.signalCache) ? this.state.signalCache : [];
    const merged = [...incomingSignals, ...existingSignals].filter((signal) => this.isSignalFreshAndValid(signal, now));

    // Prevent duplicate entries from growing cache footprint between runs.
    const deduped = new Map<string, Signal>();
    for (const signal of merged) {
      const key = `${signal.symbol}|${signal.source_detail}`;
      const previous = deduped.get(key);
      if (!previous) {
        deduped.set(key, signal);
        continue;
      }

      const shouldReplace =
        signal.timestamp > previous.timestamp ||
        (signal.timestamp === previous.timestamp && Math.abs(signal.sentiment) > Math.abs(previous.sentiment));
      if (shouldReplace) {
        deduped.set(key, signal);
      }
    }

    let nextSignals = Array.from(deduped.values())
      .sort((a, b) => {
        const sentimentDelta = Math.abs(b.sentiment) - Math.abs(a.sentiment);
        if (sentimentDelta !== 0) return sentimentDelta;
        return b.timestamp - a.timestamp;
      })
      .slice(0, SIGNAL_CACHE_MAX);

    const estimatedBytes = this.estimateObjectSizeBytes(nextSignals);
    this.state.signalCacheBytesEstimate = estimatedBytes;
    this.state.signalCachePeakBytes = Math.max(this.state.signalCachePeakBytes, estimatedBytes);

    if (estimatedBytes > SIGNAL_CACHE_MEMORY_BUDGET_BYTES) {
      const avgBytesPerSignal = Math.max(1, Math.round(estimatedBytes / Math.max(1, nextSignals.length)));
      const memoryBoundLimit = Math.floor(SIGNAL_CACHE_MEMORY_BUDGET_BYTES / avgBytesPerSignal);
      const emergencyLimit = Math.max(SIGNAL_CACHE_EMERGENCY_MIN, Math.min(nextSignals.length, memoryBoundLimit));
      nextSignals = nextSignals.slice(0, emergencyLimit);

      this.state.signalCacheCleanupCount += 1;
      this.state.signalCacheLastCleanupAt = now;
      this.state.signalCacheBytesEstimate = this.estimateObjectSizeBytes(nextSignals);

      this.log("System", "signal_cache_cleanup", {
        before_count: deduped.size,
        after_count: nextSignals.length,
        estimated_bytes: estimatedBytes,
        budget_bytes: SIGNAL_CACHE_MEMORY_BUDGET_BYTES,
        cleanup_count: this.state.signalCacheCleanupCount,
      });
      this.rememberEpisode(
        `Signal cache cleanup executed (${nextSignals.length} kept)`,
        "neutral",
        ["memory", "cache", "cleanup"],
        {
          impact: 0.35,
          confidence: 0.9,
          novelty: 0.3,
          metadata: {
            beforeCount: deduped.size,
            afterCount: nextSignals.length,
            estimatedBytes,
          },
        }
      );
    }

    this.state.signalCache = nextSignals;
  }

  private isSignalFreshAndValid(signal: Signal | null | undefined, now: number): signal is Signal {
    if (!signal) return false;
    if (!signal.symbol || !signal.source || !signal.source_detail) return false;
    if (!Number.isFinite(signal.timestamp) || signal.timestamp <= 0) return false;
    if (!Number.isFinite(signal.sentiment) || !Number.isFinite(signal.raw_sentiment)) return false;
    if (now - signal.timestamp > SIGNAL_MAX_AGE_MS) return false;
    return true;
  }

  private estimateObjectSizeBytes(value: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).length;
    } catch {
      return 0;
    }
  }

  private async gatherScoutSignals(): Promise<Signal[]> {
    if (!this.env.DATA_SCOUT) return [];

    try {
      const id = this.env.DATA_SCOUT.idFromName("default");
      const stub = this.env.DATA_SCOUT.get(id);
      const res = await this.withTimeout(
        stub.fetch("http://data-scout/signals"),
        DATA_GATHERER_TIMEOUT_MS.scout,
        "scout_signals_timeout"
      );
      if (!res.ok) {
        this.log("Scout", "signals_fetch_failed", { status: res.status });
        return [];
      }

      const payload = (await res.json()) as {
        signals?: Array<{
          symbol?: string;
          sentiment?: number;
          volume?: number;
          sources?: string[];
          timestamp?: number;
        }>;
      };

      const now = Date.now();
      const mapped: Signal[] = [];
      const sourceWeight = 0.92;

      for (const candidate of payload.signals ?? []) {
        if (!candidate || typeof candidate.symbol !== "string" || typeof candidate.sentiment !== "number") {
          continue;
        }
        const symbol = candidate.symbol.toUpperCase();
        const sentiment = Number.isFinite(candidate.sentiment) ? candidate.sentiment : 0;
        const volume = typeof candidate.volume === "number" && Number.isFinite(candidate.volume) ? candidate.volume : 1;
        const signalTimestamp =
          typeof candidate.timestamp === "number" && Number.isFinite(candidate.timestamp) ? candidate.timestamp : now;
        const sources = Array.isArray(candidate.sources) ? candidate.sources.map((s) => String(s)) : ["scout"];

        mapped.push({
          symbol,
          source: "scout",
          source_detail: `swarm_scout_${sources.slice(0, 3).join("+")}`,
          sentiment,
          raw_sentiment: sentiment,
          volume,
          freshness: calculateTimeDecay(signalTimestamp / 1000),
          source_weight: sourceWeight,
          reason: `Scout: ${sources.join(",")} volume ${volume}`,
          timestamp: signalTimestamp,
          subreddits: sources,
        });
      }

      this.log("Scout", "signals_gathered", { count: mapped.length });
      return mapped;
    } catch (error) {
      this.log("Scout", "signals_error", { error: String(error) });
      return [];
    }
  }

  private async gatherStockTwits(): Promise<Signal[]> {
    const signals: Signal[] = [];
    const sourceWeight = SOURCE_CONFIG.weights.stocktwits;

    const stocktwitsHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    };

    const fetchWithRetry = async (url: string, maxRetries = 3): Promise<Response | null> => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          const res = await fetch(url, { headers: stocktwitsHeaders });
          if (res.ok) return res;
          if (res.status === 403) {
            await this.sleep(1000 * 2 ** i);
            continue;
          }
          return null;
        } catch (error) {
          this.log("StockTwits", "fetch_retry", { url, attempt: i + 1, error: String(error) });
          await this.sleep(1000 * 2 ** i);
        }
      }
      return null;
    };

    try {
      const trendingRes = await fetchWithRetry("https://api.stocktwits.com/api/2/trending/symbols.json");
      if (!trendingRes) {
        this.log("StockTwits", "cloudflare_blocked", {
          message: "StockTwits API blocked by Cloudflare - using Reddit only",
        });
        return [];
      }
      const trendingData = (await trendingRes.json()) as { symbols?: Array<{ symbol: string }> };
      const trending = trendingData.symbols || [];

      for (const sym of trending.slice(0, 15)) {
        try {
          const streamRes = await fetchWithRetry(
            `https://api.stocktwits.com/api/2/streams/symbol/${sym.symbol}.json?limit=30`
          );
          if (!streamRes) continue;
          const streamData = (await streamRes.json()) as {
            messages?: Array<{ entities?: { sentiment?: { basic?: string } }; created_at?: string }>;
          };
          const messages = streamData.messages || [];

          let bullish = 0,
            bearish = 0,
            totalTimeDecay = 0;
          for (const msg of messages) {
            const sentiment = msg.entities?.sentiment?.basic;
            const msgTime = new Date(msg.created_at || Date.now()).getTime() / 1000;
            const timeDecay = calculateTimeDecay(msgTime);
            totalTimeDecay += timeDecay;

            if (sentiment === "Bullish") bullish += timeDecay;
            else if (sentiment === "Bearish") bearish += timeDecay;
          }

          const total = messages.length;
          const effectiveTotal = totalTimeDecay || 1;
          const score = effectiveTotal > 0 ? (bullish - bearish) / effectiveTotal : 0;
          const avgFreshness = total > 0 ? totalTimeDecay / total : 0;

          if (total >= 5) {
            const weightedSentiment = score * sourceWeight * avgFreshness;

            signals.push({
              symbol: sym.symbol,
              source: "stocktwits",
              source_detail: "stocktwits_trending",
              sentiment: weightedSentiment,
              raw_sentiment: score,
              volume: total,
              bullish: Math.round(bullish),
              bearish: Math.round(bearish),
              freshness: avgFreshness,
              source_weight: sourceWeight,
              reason: `StockTwits: ${Math.round(bullish)}B/${Math.round(bearish)}b (${(score * 100).toFixed(0)}%) [fresh:${(avgFreshness * 100).toFixed(0)}%]`,
              timestamp: Date.now(),
            });
          }

          await this.sleep(200);
        } catch (error) {
          this.log("StockTwits", "symbol_error", { symbol: sym.symbol, error: String(error) });
        }
      }
    } catch (error) {
      this.log("StockTwits", "error", { message: String(error) });
    }

    return signals;
  }

  private async gatherReddit(): Promise<Signal[]> {
    const subreddits = ["wallstreetbets", "stocks", "investing", "options"];
    const tickerData = new Map<
      string,
      {
        mentions: number;
        weightedSentiment: number;
        rawSentiment: number;
        totalQuality: number;
        upvotes: number;
        comments: number;
        sources: Set<string>;
        bestFlair: string | null;
        bestFlairMult: number;
        freshestPost: number;
      }
    >();

    const subredditBatches = await Promise.allSettled(
      subreddits.map(async (sub) => {
        const sourceWeight = SOURCE_CONFIG.weights[`reddit_${sub}` as keyof typeof SOURCE_CONFIG.weights] || 0.7;
        const res = await this.withTimeout(
          fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=25`, {
            headers: { "User-Agent": "Owokx/2.0" },
          }),
          3_500,
          `reddit_${sub}_timeout`
        );
        if (!res.ok) {
          throw new Error(`Reddit ${sub} request failed (${res.status})`);
        }
        const data = (await res.json()) as {
          data?: {
            children?: Array<{
              data: {
                title?: string;
                selftext?: string;
                created_utc?: number;
                ups?: number;
                num_comments?: number;
                link_flair_text?: string;
              };
            }>;
          };
        };
        const posts = data.data?.children?.map((c) => c.data) || [];
        return { sub, sourceWeight, posts };
      })
    );

    subredditBatches.forEach((batch, index) => {
      const sub = subreddits[index]!;
      if (batch.status !== "fulfilled") {
        this.log("Reddit", "subreddit_error", { subreddit: sub, error: String(batch.reason) });
        return;
      }

      const { sourceWeight, posts } = batch.value;
      for (const post of posts) {
        const text = `${post.title || ""} ${post.selftext || ""}`;
        const tickers = extractTickers(text, this.state.config.ticker_blacklist);
        const rawSentiment = detectSentiment(text);

        const timeDecay = calculateTimeDecay(post.created_utc || Date.now() / 1000);
        const engagementMult = getEngagementMultiplier(post.ups || 0, post.num_comments || 0);
        const flairMult = getFlairMultiplier(post.link_flair_text);
        const qualityScore = timeDecay * engagementMult * flairMult * sourceWeight;

        for (const ticker of tickers) {
          if (!tickerData.has(ticker)) {
            tickerData.set(ticker, {
              mentions: 0,
              weightedSentiment: 0,
              rawSentiment: 0,
              totalQuality: 0,
              upvotes: 0,
              comments: 0,
              sources: new Set(),
              bestFlair: null,
              bestFlairMult: 0,
              freshestPost: 0,
            });
          }
          const d = tickerData.get(ticker)!;
          d.mentions++;
          d.rawSentiment += rawSentiment;
          d.weightedSentiment += rawSentiment * qualityScore;
          d.totalQuality += qualityScore;
          d.upvotes += post.ups || 0;
          d.comments += post.num_comments || 0;
          d.sources.add(sub);

          if (flairMult > d.bestFlairMult) {
            d.bestFlair = post.link_flair_text || null;
            d.bestFlairMult = flairMult;
          }

          if ((post.created_utc || 0) > d.freshestPost) {
            d.freshestPost = post.created_utc || 0;
          }
        }
      }
    });

    const signals: Signal[] = [];
    const broker = createBrokerProviders(this.env, this.state.config.broker);

    for (const [symbol, data] of tickerData) {
      if (data.mentions >= 2) {
        if (!tickerCache.isKnownSecTicker(symbol) && broker.broker === "alpaca") {
          const cached = tickerCache.getCachedValidation(symbol);
          if (cached === false) continue;
          if (cached === undefined) {
            const isValid = await tickerCache.validateWithBroker(symbol, broker);
            if (!isValid) {
              this.log("Reddit", "invalid_ticker_filtered", { symbol });
              continue;
            }
          }
        }

        const avgRawSentiment = data.rawSentiment / data.mentions;
        const avgQuality = data.totalQuality / data.mentions;
        const finalSentiment = data.totalQuality > 0 ? data.weightedSentiment / data.mentions : avgRawSentiment * 0.5;
        const freshness = calculateTimeDecay(data.freshestPost);

        signals.push({
          symbol,
          source: "reddit",
          source_detail: `reddit_${Array.from(data.sources).join("+")}`,
          sentiment: finalSentiment,
          raw_sentiment: avgRawSentiment,
          volume: data.mentions,
          upvotes: data.upvotes,
          comments: data.comments,
          quality_score: avgQuality,
          freshness,
          best_flair: data.bestFlair,
          subreddits: Array.from(data.sources),
          source_weight: avgQuality,
          reason: `Reddit(${Array.from(data.sources).join(",")}): ${data.mentions} mentions, ${data.upvotes} upvotes, quality:${(avgQuality * 100).toFixed(0)}%`,
          timestamp: Date.now(),
        });
      }
    }

    return signals;
  }

  private async gatherCrypto(): Promise<Signal[]> {
    if (!this.state.config.crypto_enabled) return [];

    const signals: Signal[] = [];
    const symbols = this.state.config.crypto_symbols || ["BTC/USD", "ETH/USD", "SOL/USD"];
    const broker = createBrokerProviders(this.env, this.state.config.broker);

    for (const symbol of symbols) {
      try {
        const cached = tickerCache.getCachedValidation(symbol);
        if (cached === false) {
          this.log("Crypto", "symbol_not_tradable", { symbol, broker: broker.broker, source: "cache" });
          continue;
        }
        if (cached === undefined) {
          const isTradable = await tickerCache.validateWithBroker(symbol, broker);
          if (!isTradable) {
            this.log("Crypto", "symbol_not_tradable", { symbol, broker: broker.broker, source: "broker_check" });
            continue;
          }
        }

        const snapshot = await broker.marketData.getCryptoSnapshot(symbol);
        if (!snapshot) continue;
        if (!this.validateMarketData(snapshot)) continue;

        const price = snapshot.latest_trade?.price || 0;
        const prevClose = snapshot.prev_daily_bar?.c || 0;

        if (!price || !prevClose) continue;

        const momentum = ((price - prevClose) / prevClose) * 100;
        const threshold = this.state.config.crypto_momentum_threshold || 2.0;
        const hasSignificantMove = Math.abs(momentum) >= threshold;
        const isBullish = momentum > 0;

        let rawSentiment = hasSignificantMove && isBullish ? Math.min(Math.abs(momentum) / 5, 1) : 0.1;

        // Safety check: Ensure sentiment is finite. Default to 0.1 (neutral-ish) or 0 if invalid.
        if (!Number.isFinite(rawSentiment)) {
          rawSentiment = 0;
        }

        signals.push({
          symbol,
          source: "crypto",
          source_detail: "crypto_momentum",
          sentiment: rawSentiment,
          raw_sentiment: rawSentiment,
          volume: snapshot.daily_bar?.v || 0,
          freshness: 1.0,
          source_weight: 0.8,
          reason: `Crypto: ${momentum >= 0 ? "+" : ""}${momentum.toFixed(2)}% (24h)`,
          bullish: isBullish ? 1 : 0,
          bearish: isBullish ? 0 : 1,
          isCrypto: true,
          momentum,
          price,
          timestamp: Date.now(),
        });

        await this.sleep(200);
      } catch (error) {
        this.log("Crypto", "error", { symbol, message: String(error) });
      }
    }

    this.log("Crypto", "gathered_signals", { count: signals.length });
    return signals;
  }

  private async gatherSECFilings(): Promise<Signal[]> {
    const signals: Signal[] = [];

    try {
      const response = await fetch(
        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom",
        {
          headers: {
            "User-Agent": "Owokx Trading Bot (contact@example.com)",
            Accept: "application/atom+xml",
          },
        }
      );

      if (!response.ok) {
        this.log("SEC", "fetch_error", { status: response.status });
        return signals;
      }

      const text = await response.text();
      const entries = this.parseSECAtomFeed(text);

      const broker = createBrokerProviders(this.env, this.state.config.broker);
      if (broker.broker !== "alpaca") return signals;

      for (const entry of entries.slice(0, 15)) {
        const ticker = await this.resolveTickerFromCompanyName(entry.company);
        if (!ticker) continue;

        const cached = tickerCache.getCachedValidation(ticker);
        if (cached === false) continue;
        if (cached === undefined) {
          const isValid = await tickerCache.validateWithBroker(ticker, broker);
          if (!isValid) continue;
        }

        const sourceWeight = entry.form === "8-K" ? SOURCE_CONFIG.weights.sec_8k : SOURCE_CONFIG.weights.sec_4;
        const freshness = this.calculateSECFreshness(entry.updated);

        const sentiment = entry.form === "8-K" ? 0.3 : 0.2;
        const weightedSentiment = sentiment * sourceWeight * freshness;

        signals.push({
          symbol: ticker,
          source: "sec_edgar",
          source_detail: `sec_${entry.form.toLowerCase().replace("-", "")}`,
          sentiment: weightedSentiment,
          raw_sentiment: sentiment,
          volume: 1,
          freshness,
          source_weight: sourceWeight,
          reason: `SEC ${entry.form}: ${entry.company.slice(0, 50)}`,
          timestamp: Date.now(),
        });
      }

      this.log("SEC", "gathered_signals", { count: signals.length });
    } catch (error) {
      this.log("SEC", "error", { message: String(error) });
    }

    return signals;
  }

  private parseSECAtomFeed(xml: string): Array<{
    id: string;
    title: string;
    updated: string;
    form: string;
    company: string;
  }> {
    const entries: Array<{
      id: string;
      title: string;
      updated: string;
      form: string;
      company: string;
    }> = [];

    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;

    while ((match = entryRegex.exec(xml)) !== null) {
      const entryXml = match[1];
      if (!entryXml) continue;

      const id = this.extractXmlTag(entryXml, "id") || `sec_${Date.now()}_${Math.random()}`;
      const title = this.extractXmlTag(entryXml, "title") || "";
      const updated = this.extractXmlTag(entryXml, "updated") || new Date().toISOString();

      const formMatch = title.match(/\((\d+-\w+|\w+)\)/);
      const form = formMatch ? (formMatch[1] ?? "") : "";

      const companyMatch = title.match(/^([^(]+)/);
      const company = companyMatch ? (companyMatch[1]?.trim() ?? "") : "";

      if (form && company) {
        entries.push({ id, title, updated, form, company });
      }
    }

    return entries;
  }

  private extractXmlTag(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
    const match = xml.match(regex);
    return match ? (match[1] ?? null) : null;
  }

  private companyToTickerCache: Map<string, string | null> = new Map();

  private async resolveTickerFromCompanyName(companyName: string): Promise<string | null> {
    const normalized = companyName.toUpperCase().trim();

    if (this.companyToTickerCache.has(normalized)) {
      return this.companyToTickerCache.get(normalized) ?? null;
    }

    try {
      const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": "Owokx Trading Bot" },
      });

      if (!response.ok) return null;

      const data = (await response.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;

      for (const entry of Object.values(data)) {
        const entryTitle = entry.title.toUpperCase();
        if (entryTitle === normalized || normalized.includes(entryTitle) || entryTitle.includes(normalized)) {
          this.companyToTickerCache.set(normalized, entry.ticker);
          return entry.ticker;
        }
      }

      const firstWord = normalized.split(/[\s,]+/)[0];
      for (const entry of Object.values(data)) {
        if (entry.title.toUpperCase().startsWith(firstWord || "")) {
          this.companyToTickerCache.set(normalized, entry.ticker);
          return entry.ticker;
        }
      }

      this.companyToTickerCache.set(normalized, null);
      return null;
    } catch {
      return null;
    }
  }

  private calculateSECFreshness(updatedDate: string): number {
    const ageMs = Date.now() - new Date(updatedDate).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours < 1) return 1.0;
    if (ageHours < 4) return 0.9;
    if (ageHours < 12) return 0.7;
    if (ageHours < 24) return 0.5;
    return 0.3;
  }

  private async runCryptoTrading(broker: BrokerProviders, positions: Position[]): Promise<void> {
    if (!this.state.config.crypto_enabled) return;

    // Check circuit breaker first
    if (this.state.lastLLMAuthError && Date.now() - this.state.lastLLMAuthError.at < 300_000) {
      // Only log if we would have otherwise traded, or just silent skip
      return;
    }

    const cryptoSymbols = new Set(this.state.config.crypto_symbols || []);
    const cryptoPositions = positions.filter((p) => cryptoSymbols.has(p.symbol) || p.symbol.includes("/"));
    const heldCrypto = new Set(cryptoPositions.map((p) => p.symbol));

    for (const pos of cryptoPositions) {
      const entry = this.state.positionEntries[pos.symbol];
      const plPct =
        entry?.entry_price && entry.entry_price > 0
          ? ((pos.current_price - entry.entry_price) / entry.entry_price) * 100
          : pos.market_value - pos.unrealized_pl > 0
            ? (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100
            : 0;

      if (plPct >= this.state.config.crypto_take_profit_pct) {
        this.log("Crypto", "take_profit", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
        await this.executeSell(broker, pos.symbol, `Crypto take profit at +${plPct.toFixed(1)}%`);
        continue;
      }

      if (plPct <= -this.state.config.crypto_stop_loss_pct) {
        this.log("Crypto", "stop_loss", { symbol: pos.symbol, pnl: plPct.toFixed(2) });
        await this.executeSell(broker, pos.symbol, `Crypto stop loss at ${plPct.toFixed(1)}%`);
      }
    }

    const maxCryptoPositions = Math.min(this.state.config.crypto_symbols?.length || 3, 3);
    if (cryptoPositions.length >= maxCryptoPositions) return;

    const cryptoSignals = this.state.signalCache
      .filter((s) => s.isCrypto)
      .filter((s) => !heldCrypto.has(s.symbol))
      .filter((s) => s.sentiment > 0)
      .sort((a, b) => (b.momentum || 0) - (a.momentum || 0));

    for (const signal of cryptoSignals.slice(0, 2)) {
      if (cryptoPositions.length >= maxCryptoPositions) break;

      const existingResearch = this.state.signalResearch[signal.symbol];
      const CRYPTO_RESEARCH_TTL_MS = 300_000;

      let research: ResearchResult | null = existingResearch ?? null;
      if (!existingResearch || Date.now() - existingResearch.timestamp > CRYPTO_RESEARCH_TTL_MS) {
        research = await this.researchCrypto(signal.symbol, signal.momentum || 0, signal.sentiment);
      }

      if (!research || research.verdict !== "BUY") {
        this.log("Crypto", "research_skip", {
          symbol: signal.symbol,
          verdict: research?.verdict || "NO_RESEARCH",
          confidence: research?.confidence || 0,
        });
        continue;
      }

      if (research.confidence < this.state.config.min_analyst_confidence) {
        this.log("Crypto", "low_confidence", { symbol: signal.symbol, confidence: research.confidence });
        continue;
      }

      const account = await broker.trading.getAccount();
      const result = await this.executeCryptoBuy(broker, signal.symbol, research.confidence, account);

      if (result) {
        heldCrypto.add(signal.symbol);
        cryptoPositions.push({ symbol: signal.symbol } as Position);
        break;
      }
    }
  }

  private async researchCrypto(symbol: string, momentum: number, sentiment: number): Promise<ResearchResult | null> {
    if (!this._llm) {
      this.log("Crypto", "skipped_no_llm", { symbol, reason: "LLM Provider not configured" });
      return null;
    }

    if (this.state.lastLLMAuthError && Date.now() - this.state.lastLLMAuthError.at < 300_000) {
      return null; // Silent skip to avoid log spam during outage
    }

    try {
      const broker = createBrokerProviders(this.env, this.state.config.broker);
      const snapshot = await broker.marketData.getCryptoSnapshot(symbol).catch(() => null);
      const price = snapshot?.latest_trade?.price || 0;
      const dailyChange = snapshot
        ? ((snapshot.daily_bar.c - snapshot.prev_daily_bar.c) / snapshot.prev_daily_bar.c) * 100
        : 0;

      const prompt = `Should we BUY this cryptocurrency based on momentum and market conditions?

                      SYMBOL: ${symbol}
                      PRICE: $${price.toFixed(2)}
                      24H CHANGE: ${dailyChange.toFixed(2)}%
                      MOMENTUM SCORE: ${(momentum * 100).toFixed(0)}%
                      SENTIMENT: ${(sentiment * 100).toFixed(0)}% bullish

                      Evaluate if this is a good entry. Consider:
                      - Is the momentum sustainable or a trap?
                      - Any major news/events affecting this crypto?
                      - Risk/reward at current price level?

                      JSON response:
                      {
                        "verdict": "BUY|SKIP|WAIT",
                        "confidence": 0.0-1.0,
                        "entry_quality": "excellent|good|fair|poor",
                        "reasoning": "brief reason",
                        "red_flags": ["any concerns"],
                        "catalysts": ["positive factors"]
                      }`;

      const response = await this._llm.complete({
        model: this.state.config.llm_model, // Use config model (usually cheap one)
        messages: [
          {
            role: "system",
            content:
              "You are a crypto analyst. Be skeptical of FOMO. Crypto is volatile - only recommend BUY for strong setups. Output valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 250,
        temperature: 0, // Task 2: Deterministic
        seed: 42, // Task 2: Deterministic
        response_format: { type: "json_object" },
      });

      const usage = response.usage;
      if (usage) {
        this.trackLLMCost(response.model || this.state.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
      }

      const parsedAnalysis = this.parseResearchAnalysis(response.content || "{}", symbol, "research_crypto");
      if (parsedAnalysis.parseFailure) {
        this.logParseFailure(parsedAnalysis.parseFailure);
      }
      const analysis = parsedAnalysis.analysis;

      const result: ResearchResult = {
        symbol,
        verdict: analysis.verdict,
        confidence: analysis.confidence,
        sentiment: this.clampSentiment(sentiment),
        entry_quality: analysis.entry_quality,
        reasoning: analysis.reasoning,
        red_flags: analysis.red_flags || [],
        catalysts: analysis.catalysts || [],
        timestamp: Date.now(),
      };

      this.state.signalResearch[symbol] = result;
      this.log("Crypto", "researched", {
        symbol,
        verdict: result.verdict,
        confidence: result.confidence,
        quality: result.entry_quality,
      });

      return result;
    } catch (error) {
      const errorMsg = String(error);
      if (this.isLlmAuthFailure(errorMsg)) {
        this.state.lastLLMAuthError = { at: Date.now(), message: errorMsg };
        this.log("Crypto", "auth_error", {
          symbol,
          message: "ACTION REQUIRED: Invalid LLM API Key. Research disabled for 5 minutes.",
          details: errorMsg,
        });
        return null;
      }
      this.log("Crypto", "research_error", { symbol, error: errorMsg });
      return null;
    }
  }

  private async executeCryptoBuy(
    broker: BrokerProviders,
    symbol: string,
    confidence: number,
    account: Account,
    idempotencySuffix?: string
  ): Promise<boolean> {
    const sizePct = Math.min(20, this.state.config.position_size_pct_of_cash);
    const positionSize = Math.min(
      account.cash * (sizePct / 100) * confidence,
      this.state.config.crypto_max_position_value
    );

    if (positionSize < 10) {
      this.log("Crypto", "buy_skipped", { symbol, reason: "Position too small" });
      return false;
    }

    try {
      const notional = Math.round(positionSize * 100) / 100;
      const suffix = idempotencySuffix ?? String(Math.floor(Date.now() / 300_000));
      const idempotency_key = `harness:buy:${symbol}:${suffix}`;
      const execution = await this.executionService.submitOrder({
        broker,
        idempotency_key,
        order: {
          symbol,
          asset_class: "crypto",
          side: "buy",
          notional,
          order_type: "market",
          time_in_force: "gtc",
        },
      });

      this.log("Crypto", "buy_executed", {
        symbol,
        size: positionSize,
        submission_state: execution.submission.state,
        broker_order_id: execution.broker_order_id ?? null,
      });
      return execution.accepted;
    } catch (error) {
      this.log("Crypto", "buy_failed", { symbol, error: String(error) });
      return false;
    }
  }

  // ============================================================================
  // SECTION 5: TWITTER INTEGRATION
  // ============================================================================
  // [TOGGLE] Enable with TWITTER_BEARER_TOKEN secret
  // [TUNE] MAX_DAILY_READS controls API budget (default: 200/day)
  //
  // Twitter is used for CONFIRMATION only - it boosts/reduces confidence
  // on signals from other sources, doesn't generate signals itself.
  // ============================================================================

  private isTwitterEnabled(): boolean {
    return !!(this.env.X_BEARER_TOKEN || this.env.TWITTER_BEARER_TOKEN);
  }

  private canSpendTwitterRead(count = 1): boolean {
    const spendCount = Math.max(1, Math.floor(count));
    this.refillTwitterReadBucket();

    if (this.state.twitterDailyReads + spendCount > TWITTER_DAILY_READ_LIMIT) {
      return false;
    }

    return this.state.twitterReadTokens >= spendCount;
  }

  private spendTwitterRead(count = 1): void {
    const spendCount = Math.max(1, Math.floor(count));
    this.refillTwitterReadBucket();

    const hasDailyBudget = this.state.twitterDailyReads + spendCount <= TWITTER_DAILY_READ_LIMIT;
    const hasBucketTokens = this.state.twitterReadTokens >= spendCount;
    if (!hasDailyBudget || !hasBucketTokens) {
      this.log("X", "read_spend_rejected", {
        requested: spendCount,
        daily_total: this.state.twitterDailyReads,
        daily_remaining: Math.max(0, TWITTER_DAILY_READ_LIMIT - this.state.twitterDailyReads),
        bucket_tokens: Number(this.state.twitterReadTokens.toFixed(3)),
      });
      return;
    }

    this.state.twitterReadTokens = Math.max(0, this.state.twitterReadTokens - spendCount);
    this.state.twitterDailyReads += spendCount;
    this.log("X", "read_spent", {
      count: spendCount,
      daily_total: this.state.twitterDailyReads,
      budget_remaining: Math.max(0, TWITTER_DAILY_READ_LIMIT - this.state.twitterDailyReads),
      bucket_tokens_remaining: Number(this.state.twitterReadTokens.toFixed(3)),
      bucket_capacity: TWITTER_BUCKET_CAPACITY,
    });
  }

  private refillTwitterReadBucket(now = Date.now()): void {
    if (this.state.twitterDailyReadReset <= 0) {
      this.state.twitterDailyReadReset = now;
    }
    if (now - this.state.twitterDailyReadReset > TWITTER_BUCKET_DAY_MS) {
      this.state.twitterDailyReads = 0;
      this.state.twitterDailyReadReset = now;
    }

    if (this.state.twitterReadLastRefill <= 0) {
      this.state.twitterReadLastRefill = now;
    }
    if (!Number.isFinite(this.state.twitterReadTokens)) {
      this.state.twitterReadTokens = TWITTER_BUCKET_CAPACITY;
    }

    const elapsedSeconds = Math.max(0, (now - this.state.twitterReadLastRefill) / 1000);
    if (elapsedSeconds <= 0) {
      return;
    }

    const replenished = elapsedSeconds * TWITTER_BUCKET_REFILL_PER_SECOND;
    if (replenished > 0) {
      this.state.twitterReadTokens = Math.min(TWITTER_BUCKET_CAPACITY, this.state.twitterReadTokens + replenished);
      this.state.twitterReadLastRefill = now;
    }
  }

  private async twitterSearchRecent(
    query: string,
    maxResults = 10
  ): Promise<
    Array<{
      id: string;
      text: string;
      created_at: string;
      author: string;
      author_followers: number;
      retweets: number;
      likes: number;
    }>
  > {
    if (!this.isTwitterEnabled() || !this.canSpendTwitterRead()) return [];

    try {
      const params = new URLSearchParams({
        query,
        max_results: Math.max(10, Math.min(maxResults, 100)).toString(),
        "tweet.fields": "created_at,public_metrics,author_id",
        expansions: "author_id",
        "user.fields": "username,public_metrics",
      });

      const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
        headers: {
          Authorization: `Bearer ${this.env.X_BEARER_TOKEN || this.env.TWITTER_BEARER_TOKEN}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        let title = "";
        let detail = "";
        let errors: unknown;
        let raw = "";
        try {
          const body = await res.text();
          raw = body.slice(0, 500);
          try {
            const parsed = JSON.parse(body);
            title = (parsed.title as string) || "";
            detail = (parsed.detail as string) || "";
            errors = parsed.errors;
          } catch {}
        } catch {}
        const rateRemaining = res.headers.get("x-rate-limit-remaining") || "";
        const rateReset = res.headers.get("x-rate-limit-reset") || "";
        this.log("X", "api_error", {
          status: res.status,
          title,
          detail,
          errors,
          rate_limit_remaining: rateRemaining,
          rate_limit_reset: rateReset,
          body_preview: raw,
        });
        return [];
      }

      const data = (await res.json()) as {
        data?: Array<{
          id: string;
          text: string;
          created_at: string;
          author_id: string;
          public_metrics?: { retweet_count?: number; like_count?: number };
        }>;
        includes?: {
          users?: Array<{
            id: string;
            username: string;
            public_metrics?: { followers_count?: number };
          }>;
        };
      };

      this.spendTwitterRead(1);

      return (data.data || []).map((tweet) => {
        const user = data.includes?.users?.find((u) => u.id === tweet.author_id);
        return {
          id: tweet.id,
          text: tweet.text,
          created_at: tweet.created_at,
          author: user?.username || "unknown",
          author_followers: user?.public_metrics?.followers_count || 0,
          retweets: tweet.public_metrics?.retweet_count || 0,
          likes: tweet.public_metrics?.like_count || 0,
        };
      });
    } catch (error) {
      this.log("X", "error", { message: String(error) });
      return [];
    }
  }

  private async gatherTwitterConfirmation(
    symbol: string,
    existingSentiment: number
  ): Promise<TwitterConfirmation | null> {
    const MIN_SENTIMENT_FOR_CONFIRMATION = 0.3;
    const CACHE_TTL_MS = 300_000;

    if (!this.isTwitterEnabled() || !this.canSpendTwitterRead()) return null;
    if (Math.abs(existingSentiment) < MIN_SENTIMENT_FOR_CONFIRMATION) return null;

    const cached = this.state.twitterConfirmations[symbol];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached;
    }

    const actionableKeywords = [
      "unusual",
      "flow",
      "sweep",
      "block",
      "whale",
      "breaking",
      "alert",
      "upgrade",
      "downgrade",
    ];
    const query = `$${symbol} (${actionableKeywords.slice(0, 5).join(" OR ")}) -is:retweet lang:en`;
    const tweets = await this.twitterSearchRecent(query, 10);

    if (tweets.length === 0) return null;

    let bullish = 0,
      bearish = 0,
      totalWeight = 0;
    const highlights: Array<{ author: string; text: string; likes: number }> = [];

    const bullWords = ["buy", "call", "long", "bullish", "upgrade", "beat", "squeeze", "moon", "breakout"];
    const bearWords = ["sell", "put", "short", "bearish", "downgrade", "miss", "crash", "dump", "breakdown"];

    for (const tweet of tweets) {
      const text = tweet.text.toLowerCase();

      const authorWeight = Math.min(1.5, Math.log10(tweet.author_followers + 1) / 5);
      const engagementWeight = Math.min(1.3, 1 + (tweet.likes + tweet.retweets * 2) / 1000);
      const weight = authorWeight * engagementWeight;

      let sentiment = 0;
      for (const w of bullWords) if (text.includes(w)) sentiment += 1;
      for (const w of bearWords) if (text.includes(w)) sentiment -= 1;

      if (sentiment > 0) bullish += weight;
      else if (sentiment < 0) bearish += weight;
      totalWeight += weight;

      if (tweet.likes > 50 || tweet.author_followers > 10000) {
        highlights.push({
          author: tweet.author,
          text: tweet.text.slice(0, 150),
          likes: tweet.likes,
        });
      }
    }

    const twitterSentiment = totalWeight > 0 ? (bullish - bearish) / totalWeight : 0;
    const twitterBullish = twitterSentiment > 0.2;
    const twitterBearish = twitterSentiment < -0.2;
    const existingBullish = existingSentiment > 0;

    const result: TwitterConfirmation = {
      symbol,
      tweet_count: tweets.length,
      sentiment: twitterSentiment,
      confirms_existing: (twitterBullish && existingBullish) || (twitterBearish && !existingBullish),
      highlights: highlights.slice(0, 3),
      timestamp: Date.now(),
    };

    this.state.twitterConfirmations[symbol] = result;
    this.log("X", "signal_confirmed", {
      symbol,
      sentiment: twitterSentiment.toFixed(2),
      confirms: result.confirms_existing,
      tweet_count: tweets.length,
    });

    return result;
  }

  private async checkTwitterBreakingNews(symbols: string[]): Promise<
    Array<{
      symbol: string;
      headline: string;
      author: string;
      age_minutes: number;
      is_breaking: boolean;
    }>
  > {
    if (!this.isTwitterEnabled() || !this.canSpendTwitterRead() || symbols.length === 0) return [];

    const toCheck = symbols.slice(0, 3);
    const newsQuery = `(from:FirstSquawk OR from:DeItaone OR from:Newsquawk) (${toCheck.map((s) => `$${s}`).join(" OR ")}) -is:retweet`;
    const tweets = await this.twitterSearchRecent(newsQuery, 5);

    const results: Array<{
      symbol: string;
      headline: string;
      author: string;
      age_minutes: number;
      is_breaking: boolean;
    }> = [];

    const MAX_NEWS_AGE_MS = 1800_000;
    const BREAKING_THRESHOLD_MS = 600_000;

    for (const tweet of tweets) {
      const tweetAge = Date.now() - new Date(tweet.created_at).getTime();
      if (tweetAge > MAX_NEWS_AGE_MS) continue;

      const mentionedSymbol = toCheck.find(
        (s) => tweet.text.toUpperCase().includes(`$${s}`) || tweet.text.toUpperCase().includes(` ${s} `)
      );

      if (mentionedSymbol) {
        results.push({
          symbol: mentionedSymbol,
          headline: tweet.text.slice(0, 200),
          author: tweet.author,
          age_minutes: Math.round(tweetAge / 60000),
          is_breaking: tweetAge < BREAKING_THRESHOLD_MS,
        });
      }
    }

    if (results.length > 0) {
      this.log("X", "breaking_news_found", {
        count: results.length,
        symbols: results.map((r) => r.symbol),
      });
    }

    return results;
  }

  // ============================================================================
  // SECTION 6: LLM RESEARCH
  // ============================================================================
  // [CUSTOMIZABLE] Modify prompts to change how the AI analyzes signals.
  //
  // Key methods:
  // - researchSignal(): Evaluates individual symbols (BUY/SKIP/WAIT)
  // - researchPosition(): Analyzes held positions (HOLD/SELL/ADD)
  // - analyzeSignalsWithLLM(): Batch analysis for trading decisions
  //
  // [TUNE] Change llm_model and llm_analyst_model in config for cost/quality
  // ============================================================================

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private clampSentiment(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-1, Math.min(1, value));
  }

  private ensureSignalResearchSentiment(): void {
    if (!this.state.signalResearch || typeof this.state.signalResearch !== "object") {
      this.state.signalResearch = {};
      return;
    }

    const signalSentimentBySymbol = new Map(
      this.state.signalCache
        .filter((signal) => typeof signal?.symbol === "string")
        .map((signal) => [signal.symbol.toUpperCase(), this.clampSentiment(signal.sentiment)])
    );

    for (const [symbol, research] of Object.entries(this.state.signalResearch)) {
      if (!research || typeof research !== "object") continue;

      const rawSentiment = (research as { sentiment?: unknown }).sentiment;
      const parsedSentiment = typeof rawSentiment === "number" ? rawSentiment : Number(rawSentiment);
      if (Number.isFinite(parsedSentiment)) {
        research.sentiment = this.clampSentiment(parsedSentiment);
        continue;
      }

      research.sentiment = signalSentimentBySymbol.get(symbol.toUpperCase()) ?? 0;
    }
  }

  private sigmoid(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
    if (value > 20) return 1;
    if (value < -20) return 0;
    return 1 / (1 + Math.exp(-value));
  }

  private computeSignalDispersion(): number {
    const values = this.state.signalCache
      .map((signal) => signal.sentiment)
      .filter((value) => Number.isFinite(value))
      .slice(0, 120);
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(Math.max(variance, 0));
  }

  private computeStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(Math.max(variance, 0));
  }

  private computeSignalCorrelation(
    left: { sentiment: number; mentions: number; freshness: number; sources: Set<string> },
    right: { sentiment: number; mentions: number; freshness: number; sources: Set<string> }
  ): number {
    const sharedSources = new Set([...left.sources].filter((source) => right.sources.has(source))).size;
    const sourceUnion = new Set([...left.sources, ...right.sources]).size;
    const sourceOverlap = sourceUnion > 0 ? sharedSources / sourceUnion : 0;
    const sentimentAlignment = 1 - Math.min(2, Math.abs(left.sentiment - right.sentiment)) / 2;
    const freshnessAlignment = 1 - Math.min(1, Math.abs(left.freshness - right.freshness));
    const volumeRatio =
      Math.min(Math.max(left.mentions, 1), Math.max(right.mentions, 1)) /
      Math.max(Math.max(left.mentions, 1), Math.max(right.mentions, 1));

    return this.clamp01(
      sourceOverlap * 0.45 + sentimentAlignment * 0.3 + freshnessAlignment * 0.15 + volumeRatio * 0.1
    );
  }

  private computeCandidateOutlierScores(
    candidates: Array<{ symbol: string; sentiment: number; mentions: number; freshness: number; sourceCount: number }>
  ): Record<string, number> {
    if (candidates.length < 5) return {};

    const absSentiments = candidates.map((candidate) => Math.abs(candidate.sentiment));
    const logMentions = candidates.map((candidate) => Math.log10(Math.max(1, candidate.mentions)));
    const freshness = candidates.map((candidate) => this.clamp01(candidate.freshness));
    const sourceDiversity = candidates.map((candidate) => this.clamp01(candidate.sourceCount / 4));

    const meanSentiment = absSentiments.reduce((sum, value) => sum + value, 0) / absSentiments.length;
    const meanMentions = logMentions.reduce((sum, value) => sum + value, 0) / logMentions.length;
    const meanFreshness = freshness.reduce((sum, value) => sum + value, 0) / freshness.length;
    const meanSourceDiversity = sourceDiversity.reduce((sum, value) => sum + value, 0) / sourceDiversity.length;

    const stdevSentiment = this.computeStdDev(absSentiments);
    const stdevMentions = this.computeStdDev(logMentions);
    const stdevFreshness = this.computeStdDev(freshness);
    const stdevSourceDiversity = this.computeStdDev(sourceDiversity);

    const scores: Record<string, number> = {};
    for (const candidate of candidates) {
      const zSentiment =
        stdevSentiment > 0 ? Math.abs(Math.abs(candidate.sentiment) - meanSentiment) / stdevSentiment : 0;
      const zMentions =
        stdevMentions > 0 ? Math.abs(Math.log10(Math.max(1, candidate.mentions)) - meanMentions) / stdevMentions : 0;
      const zFreshness = stdevFreshness > 0 ? Math.abs(candidate.freshness - meanFreshness) / stdevFreshness : 0;
      const zSource =
        stdevSourceDiversity > 0
          ? Math.abs(this.clamp01(candidate.sourceCount / 4) - meanSourceDiversity) / stdevSourceDiversity
          : 0;

      scores[candidate.symbol] = zSentiment * 0.5 + zMentions * 0.25 + zFreshness * 0.15 + zSource * 0.1;
    }
    return scores;
  }

  private computeDynamicPositionScale(
    volatility: number,
    confidence: number,
    riskMultiplier: number,
    regime: "trending" | "ranging" | "volatile"
  ): number {
    const normalizedVol = this.clamp01((volatility - 0.01) / 0.04);
    const volatilityScale = 1 - normalizedVol * 0.55;
    const confidenceScale = 0.75 + this.clamp01(confidence) * 0.5;
    const regimeScale = regime === "volatile" ? 0.82 : regime === "trending" ? 1.08 : 0.96;
    return Math.max(0.35, Math.min(1.25, volatilityScale * confidenceScale * riskMultiplier * regimeScale));
  }

  private async estimateSymbolVolatility(broker: BrokerProviders, symbol: string, isCrypto: boolean): Promise<number> {
    try {
      const instrument = isCrypto ? normalizeCryptoSymbol(symbol) : symbol;
      const bars = await broker.marketData.getBars(instrument, "1Day", { limit: 40 });
      if (!bars || bars.length < 8) return 0.02;

      const closes = bars.map((bar) => bar.c).filter((price) => Number.isFinite(price) && price > 0);
      if (closes.length < 8) return 0.02;

      const returns: number[] = [];
      for (let i = 1; i < closes.length; i += 1) {
        const prev = closes[i - 1] ?? 0;
        const next = closes[i] ?? prev;
        if (prev > 0) returns.push((next - prev) / prev);
      }
      return Math.max(0.005, this.computeStdDev(returns));
    } catch {
      return 0.02;
    }
  }

  private estimatePositionPnLPct(position: Position, entry: PositionEntry | undefined): number {
    if (entry?.entry_price && entry.entry_price > 0) {
      return ((position.current_price - entry.entry_price) / entry.entry_price) * 100;
    }
    const denominator = position.market_value - position.unrealized_pl;
    if (!Number.isFinite(denominator) || denominator <= 0) return 0;
    return (position.unrealized_pl / denominator) * 100;
  }

  private computeAdaptiveExitThresholds(
    riskProfile: DynamicRiskProfile,
    position: Position,
    entry: PositionEntry | undefined
  ): {
    takeProfitPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    peakDrawdownPct: number;
  } {
    const regime = riskProfile.marketRegime;
    const volPressure = this.clamp01((riskProfile.realizedVolatility - 0.01) / 0.04);
    const drawdownPressure = this.clamp01(riskProfile.maxDrawdownPct / 0.15);
    const baseTake = this.state.config.take_profit_pct;
    const baseStop = this.state.config.stop_loss_pct;

    const regimeTakeMult = regime === "trending" ? 1.12 : regime === "volatile" ? 0.9 : 1;
    const regimeStopMult = regime === "volatile" ? 0.78 : regime === "trending" ? 1.08 : 0.95;
    const riskTightenMult = 1 - drawdownPressure * 0.2;

    const takeProfitPct = Math.max(2.5, baseTake * regimeTakeMult * (1 - volPressure * 0.12));
    const stopLossPct = Math.max(1.5, baseStop * regimeStopMult * riskTightenMult);

    const peakPrice = entry?.peak_price ?? 0;
    const peakDrawdownPct =
      peakPrice > 0 && Number.isFinite(position.current_price)
        ? ((position.current_price - peakPrice) / peakPrice) * 100
        : 0;
    const trailingStopPct = Math.max(1.8, Math.min(stopLossPct, stopLossPct * 0.7));

    return { takeProfitPct, stopLossPct, trailingStopPct, peakDrawdownPct };
  }

  private buildPortfolioRiskDashboard(account: Account | null, positions: Position[]): PortfolioRiskDashboard | null {
    if (!account) return null;

    const metrics = this.computePortfolioRiskMetrics();
    const totalLong = positions.reduce((sum, position) => sum + Math.max(0, position.market_value), 0);
    const totalShort = positions
      .filter((position) => position.side === "short")
      .reduce((sum, position) => sum + Math.abs(position.market_value), 0);
    const grossExposureUsd = totalLong + totalShort;
    const netExposureUsd = totalLong - totalShort;
    const leverage = account.equity > 0 ? grossExposureUsd / account.equity : 0;

    const sortedBySize = [...positions].sort(
      (left, right) => Math.abs(right.market_value) - Math.abs(left.market_value)
    );
    const largestPositionPct =
      account.equity > 0 && sortedBySize.length > 0
        ? Math.abs((sortedBySize[0]?.market_value ?? 0) / account.equity)
        : 0;
    const concentrationTop3Usd = sortedBySize
      .slice(0, 3)
      .reduce((sum, position) => sum + Math.abs(position.market_value), 0);
    const concentrationTop3Pct = account.equity > 0 ? concentrationTop3Usd / account.equity : 0;

    const points = this.state.portfolioEquityHistory.slice(-320);
    const returns: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1]?.equity ?? 0;
      const next = points[i]?.equity ?? prev;
      if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) {
        returns.push((next - prev) / prev);
      }
    }
    const negatives = returns.filter((value) => value < 0).sort((a, b) => a - b);
    const varIndex = Math.max(0, Math.floor(negatives.length * 0.05) - 1);
    const valueAtRisk95Pct =
      negatives.length > 0 ? Math.abs(negatives[varIndex] ?? 0) : metrics.realizedVolatility * 1.65;
    const tail = negatives.slice(0, Math.max(1, Math.floor(negatives.length * 0.05)));
    const expectedShortfall95Pct =
      tail.length > 0 ? Math.abs(tail.reduce((sum, value) => sum + value, 0) / tail.length) : valueAtRisk95Pct;

    return {
      timestamp: Date.now(),
      regime: metrics.regime,
      realizedVolatility: metrics.realizedVolatility,
      maxDrawdownPct: metrics.maxDrawdownPct,
      sharpeLike: metrics.sharpeLike,
      valueAtRisk95Pct,
      expectedShortfall95Pct,
      grossExposureUsd,
      netExposureUsd,
      leverage,
      largestPositionPct,
      concentrationTop3Pct,
    };
  }

  private buildSignalQualityMetrics(heldSymbols: Set<string>): SignalQualityMetrics {
    const recentSignals = this.state.signalCache
      .filter((signal) => Number.isFinite(signal.timestamp) && Date.now() - signal.timestamp <= 3 * 60 * 60 * 1000)
      .slice(0, 200);

    const aggregated = new Map<
      string,
      { symbol: string; sentiment: number; mentions: number; freshness: number; sources: Set<string> }
    >();

    for (const signal of recentSignals) {
      const symbol = signal.symbol.toUpperCase();
      if (!aggregated.has(symbol)) {
        aggregated.set(symbol, { symbol, sentiment: 0, mentions: 0, freshness: 0, sources: new Set<string>() });
      }
      const entry = aggregated.get(symbol)!;
      entry.sentiment += signal.sentiment;
      entry.mentions += 1;
      entry.freshness = Math.max(entry.freshness, this.clamp01(signal.freshness));
      entry.sources.add(signal.source);
    }

    const candidates = Array.from(aggregated.values()).map((entry) => ({
      ...entry,
      sentiment: entry.mentions > 0 ? entry.sentiment / entry.mentions : 0,
    }));
    const outlierScores = this.computeCandidateOutlierScores(
      candidates.map((candidate) => ({
        symbol: candidate.symbol,
        sentiment: candidate.sentiment,
        mentions: candidate.mentions,
        freshness: candidate.freshness,
        sourceCount: candidate.sources.size,
      }))
    );
    const filteredSymbols = candidates
      .filter((candidate) => (outlierScores[candidate.symbol] ?? 0) >= 2.4)
      .map((candidate) => candidate.symbol);

    const pairScores: Array<{ left: string; right: string; correlation: number }> = [];
    let totalCorrelation = 0;
    let pairCount = 0;
    let maxCorrelation = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const left = candidates[i]!;
        const right = candidates[j]!;
        const correlation = this.computeSignalCorrelation(left, right);
        totalCorrelation += correlation;
        pairCount += 1;
        maxCorrelation = Math.max(maxCorrelation, correlation);
        if (correlation >= 0.8) {
          pairScores.push({ left: left.symbol, right: right.symbol, correlation });
        }
      }
    }
    pairScores.sort((left, right) => right.correlation - left.correlation);

    return {
      timestamp: Date.now(),
      totalSignals: recentSignals.length,
      uniqueSymbols: candidates.length,
      outlierCount: filteredSymbols.length,
      averageCorrelation: pairCount > 0 ? totalCorrelation / pairCount : 0,
      maxCorrelation: pairCount > 0 ? maxCorrelation : 0,
      highCorrelationPairs: pairScores.slice(0, 8),
      filteredSymbols: filteredSymbols.filter((symbol) => !heldSymbols.has(symbol)).slice(0, 8),
    };
  }

  private buildSignalPerformanceAttribution(): SignalPerformanceAttribution {
    const perSymbol = Object.entries(this.state.predictiveModel.perSymbol || {})
      .map(([symbol, stats]) => {
        const samples = Math.max(0, stats.samples || 0);
        const wins = Math.max(0, stats.wins || 0);
        const winRate = samples > 0 ? wins / samples : 0;
        return {
          symbol,
          samples,
          winRate,
          avgReturnPct: Number(stats.avgReturnPct || 0),
        };
      })
      .filter((row) => row.samples > 0);

    const totalSamples = perSymbol.reduce((sum, row) => sum + row.samples, 0);
    const weightedAvgReturn =
      totalSamples > 0 ? perSymbol.reduce((sum, row) => sum + row.avgReturnPct * row.samples, 0) / totalSamples : 0;

    const weights = this.state.predictiveModel.weights;
    const absTotal =
      Math.abs(weights.sentiment) +
        Math.abs(weights.freshness) +
        Math.abs(weights.sourceDiversity) +
        Math.abs(weights.logVolume) +
        Math.abs(weights.regimeAlignment) || 1;
    const factorAttribution = [
      { factor: "sentiment", contribution: Math.abs(weights.sentiment) / absTotal },
      { factor: "freshness", contribution: Math.abs(weights.freshness) / absTotal },
      { factor: "sourceDiversity", contribution: Math.abs(weights.sourceDiversity) / absTotal },
      { factor: "volume", contribution: Math.abs(weights.logVolume) / absTotal },
      { factor: "regimeAlignment", contribution: Math.abs(weights.regimeAlignment) / absTotal },
    ].sort((left, right) => right.contribution - left.contribution);

    return {
      timestamp: Date.now(),
      totalSamples,
      hitRate: this.clamp01(this.state.predictiveModel.hitRate),
      avgReturnPct: weightedAvgReturn,
      topSymbols: [...perSymbol].sort((left, right) => right.avgReturnPct - left.avgReturnPct).slice(0, 5),
      laggingSymbols: [...perSymbol].sort((left, right) => left.avgReturnPct - right.avgReturnPct).slice(0, 5),
      factorAttribution,
    };
  }

  private shouldBlockCorrelatedTrade(
    candidateSymbol: string,
    heldSymbols: Set<string>
  ): { blocked: boolean; maxCorrelation: number; peer: string | null } {
    const buildProfile = (symbol: string) => {
      const samples = this.state.signalCache.filter((signal) => signal.symbol === symbol);
      if (samples.length === 0) return null;
      const mentions = samples.length;
      return {
        sentiment: samples.reduce((sum, signal) => sum + signal.sentiment, 0) / mentions,
        mentions,
        freshness: samples.reduce((max, signal) => Math.max(max, this.clamp01(signal.freshness || 0)), 0),
        sources: new Set(samples.map((signal) => signal.source)),
      };
    };

    const candidate = buildProfile(candidateSymbol);
    if (!candidate) return { blocked: false, maxCorrelation: 0, peer: null };

    let maxCorrelation = 0;
    let maxPeer: string | null = null;
    for (const heldSymbol of heldSymbols) {
      const peer = buildProfile(heldSymbol);
      if (!peer) continue;
      const correlation = this.computeSignalCorrelation(candidate, peer);
      if (correlation > maxCorrelation) {
        maxCorrelation = correlation;
        maxPeer = heldSymbol;
      }
    }

    return { blocked: maxCorrelation >= 0.84, maxCorrelation, peer: maxPeer };
  }

  private computeRegimeAlignment(signalSentiment: number, regime: "trending" | "ranging" | "volatile"): number {
    const direction = signalSentiment >= 0 ? 1 : -1;
    if (regime === "trending") return 0.7 * direction;
    if (regime === "volatile") return direction > 0 ? 0.1 : -0.2;
    return 0;
  }

  private applyRegimeConfidenceAdjustment(confidence: number, sentiment: number): number {
    const regime = this.state.marketRegime;
    let adjusted = confidence;
    if (regime.type === "volatile") {
      adjusted -= 0.08 * regime.confidence;
    } else if (regime.type === "trending") {
      adjusted += sentiment >= 0 ? 0.05 * regime.confidence : -0.03 * regime.confidence;
    } else {
      adjusted -= 0.02 * regime.confidence;
    }
    return this.clamp01(adjusted);
  }

  private predictSignalProbability(
    signal: Pick<Signal, "symbol" | "sentiment" | "freshness" | "volume"> & { sourceDiversity?: number }
  ): number {
    const model = this.state.predictiveModel;
    const sourceDiversity =
      typeof signal.sourceDiversity === "number"
        ? signal.sourceDiversity
        : new Set(this.state.signalCache.filter((s) => s.symbol === signal.symbol).map((s) => s.source)).size;
    const features = {
      sentiment: this.clamp01((signal.sentiment + 1) / 2),
      freshness: this.clamp01(signal.freshness),
      sourceDiversity: this.clamp01(sourceDiversity / 4),
      logVolume: this.clamp01(Math.log10(Math.max(1, signal.volume || 1)) / 3),
      regimeAlignment: this.clamp01(
        (this.computeRegimeAlignment(signal.sentiment, this.state.marketRegime.type) + 1) / 2
      ),
    };
    const linear =
      model.bias +
      model.weights.sentiment * (features.sentiment - 0.5) * 2 +
      model.weights.freshness * (features.freshness - 0.5) * 2 +
      model.weights.sourceDiversity * (features.sourceDiversity - 0.5) * 2 +
      model.weights.logVolume * (features.logVolume - 0.5) * 2 +
      model.weights.regimeAlignment * (features.regimeAlignment - 0.5) * 2;
    return this.clamp01(this.sigmoid(linear));
  }

  private updatePredictiveModelFromTrade(symbol: string, outcomeReturnPct: number, entry?: PositionEntry): void {
    const model = this.state.predictiveModel;
    const target = outcomeReturnPct > 0 ? 1 : 0;
    const prediction = this.clamp01(entry?.entry_prediction ?? 0.5);
    const error = target - prediction;
    const lr = model.learningRate;

    // Lightweight online update keeps model adaptive without expensive retraining.
    model.bias += lr * error * 0.25;
    model.weights.sentiment += lr * error * (entry?.entry_sentiment ?? 0);
    model.weights.freshness += lr * error * 0.15;
    model.weights.sourceDiversity += lr * error * Math.min(1, (entry?.entry_sources?.length || 1) / 4);
    model.weights.logVolume += lr * error * Math.min(1, Math.log10(Math.max(1, entry?.entry_social_volume || 1)) / 3);
    model.weights.regimeAlignment +=
      lr * error * (entry?.entry_regime === "trending" ? 0.5 : entry?.entry_regime === "volatile" ? -0.2 : 0.1);
    model.weights.sentiment = Math.max(-3, Math.min(3, model.weights.sentiment));
    model.weights.freshness = Math.max(-3, Math.min(3, model.weights.freshness));
    model.weights.sourceDiversity = Math.max(-3, Math.min(3, model.weights.sourceDiversity));
    model.weights.logVolume = Math.max(-3, Math.min(3, model.weights.logVolume));
    model.weights.regimeAlignment = Math.max(-3, Math.min(3, model.weights.regimeAlignment));

    model.samples += 1;
    model.hitRate =
      (model.hitRate * Math.max(0, model.samples - 1) +
        (error === 0 ? 1 : target === (prediction >= 0.5 ? 1 : 0) ? 1 : 0)) /
        model.samples || 0;
    model.mse = (model.mse * Math.max(0, model.samples - 1) + error ** 2) / model.samples || 0;
    model.lastUpdatedAt = Date.now();

    const upper = symbol.toUpperCase();
    const stats = model.perSymbol[upper] ?? {
      samples: 0,
      wins: 0,
      losses: 0,
      avgReturnPct: 0,
      lastOutcomeAt: 0,
    };
    stats.samples += 1;
    if (outcomeReturnPct > 0) stats.wins += 1;
    else stats.losses += 1;
    stats.avgReturnPct = (stats.avgReturnPct * (stats.samples - 1) + outcomeReturnPct) / stats.samples;
    stats.lastOutcomeAt = Date.now();
    model.perSymbol[upper] = stats;
  }

  private deriveHistoricalShockPct(): number {
    const points = this.state.portfolioEquityHistory.slice(-240);
    if (points.length < 10) return -0.08;

    const returns: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1]?.equity ?? 0;
      const next = points[i]?.equity ?? prev;
      if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) {
        returns.push((next - prev) / prev);
      }
    }
    const negatives = returns.filter((value) => value < 0).sort((a, b) => a - b);
    if (negatives.length === 0) return -0.05;
    const idx = Math.max(0, Math.floor(negatives.length * 0.1) - 1);
    return negatives[idx] ?? -0.08;
  }

  private runStressTest(account: Account, positions: Position[]): StressTestResult {
    const totalExposure = positions.reduce((sum, pos) => sum + Math.max(0, pos.market_value || 0), 0);
    const cryptoExposure = positions
      .filter(
        (pos) => isCryptoSymbol(pos.symbol, this.state.config.crypto_symbols || []) || pos.asset_class === "crypto"
      )
      .reduce((sum, pos) => sum + Math.max(0, pos.market_value || 0), 0);
    const equityExposure = Math.max(0, totalExposure - cryptoExposure);
    const historicalShockPct = this.deriveHistoricalShockPct();

    const scenarios: Array<{ name: string; shockPct: number; projectedLoss: number; projectedDrawdownPct: number }> = [
      { name: "flash_crash", shockPct: -0.1, projectedLoss: totalExposure * 0.1, projectedDrawdownPct: 0 },
      {
        name: "macro_bear",
        shockPct: -0.16,
        projectedLoss: equityExposure * 0.16 + cryptoExposure * 0.2,
        projectedDrawdownPct: 0,
      },
      { name: "volatility_spike", shockPct: -0.12, projectedLoss: totalExposure * 0.12, projectedDrawdownPct: 0 },
      {
        name: "historical_10pct_tail",
        shockPct: historicalShockPct,
        projectedLoss: totalExposure * Math.abs(historicalShockPct),
        projectedDrawdownPct: 0,
      },
    ];

    for (const scenario of scenarios) {
      scenario.projectedDrawdownPct = account.equity > 0 ? scenario.projectedLoss / account.equity : 1;
    }

    const worstCaseLoss = scenarios.reduce((max, scenario) => Math.max(max, scenario.projectedLoss), 0);
    const worstCaseDrawdownPct = account.equity > 0 ? worstCaseLoss / account.equity : 1;
    const passed = worstCaseDrawdownPct <= 0.12;
    const recommendedRiskMultiplier = passed
      ? Math.max(0.7, 1 - worstCaseDrawdownPct)
      : Math.max(0.3, 0.95 - worstCaseDrawdownPct * 2.5);

    const report: StressTestResult = {
      timestamp: Date.now(),
      passed,
      worstCaseLoss,
      worstCaseDrawdownPct,
      recommendedRiskMultiplier,
      historicalShockPct,
      scenarios,
    };
    this.state.lastStressTest = report;
    this.rememberEpisode(
      `Stress test ${passed ? "passed" : "failed"} (worst drawdown ${(worstCaseDrawdownPct * 100).toFixed(1)}%)`,
      passed ? "success" : "failure",
      ["risk", "stress_test", this.state.marketRegime.type],
      {
        impact: Math.min(1, worstCaseDrawdownPct),
        confidence: this.clamp01(1 - Math.abs(report.recommendedRiskMultiplier - 0.7)),
        novelty: 0.3,
        metadata: {
          recommendedRiskMultiplier: report.recommendedRiskMultiplier,
          historicalShockPct,
        },
      }
    );

    this.log("Risk", "stress_test_complete", {
      passed,
      worst_case_drawdown_pct: Number((worstCaseDrawdownPct * 100).toFixed(2)),
      recommended_multiplier: Number(recommendedRiskMultiplier.toFixed(3)),
    });
    return report;
  }

  private recordPerformanceSample(
    stage: "gather" | "research" | "analyst",
    durationMs: number,
    hadError: boolean
  ): void {
    const opt = this.state.optimization;
    const alpha = 0.2;
    const updateEma = (current: number, next: number) => (current <= 0 ? next : current * (1 - alpha) + next * alpha);

    if (stage === "gather") {
      opt.gatherLatencyEmaMs = updateEma(opt.gatherLatencyEmaMs, durationMs);
    } else if (stage === "research") {
      opt.researchLatencyEmaMs = updateEma(opt.researchLatencyEmaMs, durationMs);
    } else {
      opt.analystLatencyEmaMs = updateEma(opt.analystLatencyEmaMs, durationMs);
    }

    const errorPoint = hadError ? 1 : 0;
    opt.errorRateEma = updateEma(opt.errorRateEma, errorPoint);
  }

  private optimizeRuntimeParameters(now = Date.now()): void {
    const opt = this.state.optimization;
    const maxDataPoll = 60_000;
    const minDataPoll = 10_000;
    const maxResearch = 240_000;
    const minResearch = 60_000;
    const maxAnalyst = 240_000;
    const minAnalyst = 60_000;

    let dataPoll = opt.adaptiveDataPollIntervalMs || this.state.config.data_poll_interval_ms;
    let research = opt.adaptiveResearchIntervalMs || 120_000;
    let analyst = opt.adaptiveAnalystIntervalMs || this.state.config.analyst_interval_ms;

    const overloaded =
      opt.errorRateEma > 0.2 ||
      opt.gatherLatencyEmaMs > 4_000 ||
      opt.researchLatencyEmaMs > 7_000 ||
      opt.analystLatencyEmaMs > 8_000;
    const healthy =
      opt.errorRateEma < 0.05 &&
      opt.gatherLatencyEmaMs > 0 &&
      opt.gatherLatencyEmaMs < 2_000 &&
      opt.researchLatencyEmaMs < 4_000;

    if (overloaded) {
      dataPoll = Math.min(maxDataPoll, Math.round(dataPoll * 1.15));
      research = Math.min(maxResearch, Math.round(research * 1.15));
      analyst = Math.min(maxAnalyst, Math.round(analyst * 1.12));
    } else if (healthy) {
      dataPoll = Math.max(minDataPoll, Math.round(dataPoll * 0.92));
      research = Math.max(minResearch, Math.round(research * 0.93));
      analyst = Math.max(minAnalyst, Math.round(analyst * 0.94));
    }

    opt.adaptiveDataPollIntervalMs = dataPoll;
    opt.adaptiveResearchIntervalMs = research;
    opt.adaptiveAnalystIntervalMs = analyst;
    opt.optimizationRuns += 1;
    opt.lastOptimizationAt = now;

    this.log("System", "runtime_optimized", {
      data_poll_ms: dataPoll,
      research_ms: research,
      analyst_ms: analyst,
      gather_ema_ms: Number(opt.gatherLatencyEmaMs.toFixed(1)),
      research_ema_ms: Number(opt.researchLatencyEmaMs.toFixed(1)),
      analyst_ema_ms: Number(opt.analystLatencyEmaMs.toFixed(1)),
      error_rate_ema: Number(opt.errorRateEma.toFixed(3)),
      overloaded,
      healthy,
    });
  }

  private mapEntryQualityFromConfidence(confidence: number): "excellent" | "good" | "fair" | "poor" {
    if (confidence >= 0.85) return "excellent";
    if (confidence >= 0.7) return "good";
    if (confidence >= 0.55) return "fair";
    return "poor";
  }

  private calculateEMA(values: number[], period: number): number[] {
    if (values.length === 0 || period <= 0) return [];
    const smoothing = 2 / (period + 1);
    const output: number[] = [];
    let ema = values[0] ?? 0;
    output.push(ema);
    for (let i = 1; i < values.length; i += 1) {
      const current = values[i] ?? ema;
      ema = current * smoothing + ema * (1 - smoothing);
      output.push(ema);
    }
    return output;
  }

  private computePortfolioRiskMetrics(): {
    realizedVolatility: number;
    maxDrawdownPct: number;
    sharpeLike: number;
    regime: "trending" | "ranging" | "volatile";
    trendStrength: number;
    sentimentDispersion: number;
  } {
    const points = this.state.portfolioEquityHistory.slice(-180);
    if (points.length < 3) {
      return {
        realizedVolatility: 0.01,
        maxDrawdownPct: 0,
        sharpeLike: 0,
        regime: "ranging",
        trendStrength: 0,
        sentimentDispersion: this.computeSignalDispersion(),
      };
    }

    const returns: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1]?.equity ?? 0;
      const next = points[i]?.equity ?? prev;
      if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) {
        returns.push((next - prev) / prev);
      }
    }

    if (returns.length === 0) {
      return {
        realizedVolatility: 0.01,
        maxDrawdownPct: 0,
        sharpeLike: 0,
        regime: "ranging",
        trendStrength: 0,
        sentimentDispersion: this.computeSignalDispersion(),
      };
    }

    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
    const stdev = Math.sqrt(Math.max(variance, 0));

    let peak = points[0]?.equity ?? 0;
    let maxDrawdownPct = 0;
    for (const point of points) {
      if (!point || !Number.isFinite(point.equity)) continue;
      peak = Math.max(peak, point.equity);
      if (peak > 0) {
        const drawdown = (peak - point.equity) / peak;
        maxDrawdownPct = Math.max(maxDrawdownPct, drawdown);
      }
    }

    const sharpeLike = stdev > 0 ? (mean / stdev) * Math.sqrt(Math.min(returns.length, 252)) : 0;
    const trendStrength = mean * Math.sqrt(Math.min(returns.length, 252));
    const sentimentDispersion = this.computeSignalDispersion();

    let regime: "trending" | "ranging" | "volatile" = "ranging";
    if (stdev > 0.03 || sentimentDispersion > 0.45) {
      regime = "volatile";
    } else if (Math.abs(trendStrength) > 0.35 && Math.abs(sharpeLike) > 0.5) {
      regime = "trending";
    }

    const previous = this.state.marketRegime;
    const nextSince = previous.type === regime ? previous.since || Date.now() : Date.now();
    const confidenceComponents = [
      this.clamp01(stdev / 0.04),
      this.clamp01(Math.abs(trendStrength) / 0.8),
      this.clamp01(Math.abs(sharpeLike) / 1.5),
      this.clamp01(sentimentDispersion / 0.6),
    ];
    const confidence = confidenceComponents.reduce((sum, value) => sum + value, 0) / confidenceComponents.length;
    this.state.marketRegime = {
      type: regime,
      confidence,
      duration: Math.max(0, Date.now() - nextSince),
      characteristics: {
        volatility: stdev,
        trend: trendStrength,
        sharpe_like: sharpeLike,
        sentiment_dispersion: sentimentDispersion,
      },
      detectedAt: Date.now(),
      since: nextSince,
    };

    return {
      realizedVolatility: stdev,
      maxDrawdownPct,
      sharpeLike,
      regime,
      trendStrength,
      sentimentDispersion,
    };
  }

  private getDynamicRiskProfile(account: Account): DynamicRiskProfile {
    const metrics = this.computePortfolioRiskMetrics();
    const dailyPnlPct =
      Number.isFinite(account.last_equity) && account.last_equity > 0
        ? (account.equity - account.last_equity) / account.last_equity
        : 0;

    const volatilityPenalty = Math.max(0, (metrics.realizedVolatility - 0.01) * 12);
    const drawdownPenalty = Math.max(0, metrics.maxDrawdownPct * 3);
    const dailyLossPenalty = Math.max(0, -dailyPnlPct * 5);
    const regimePenalty = metrics.regime === "volatile" ? 0.25 : metrics.regime === "trending" ? -0.05 : 0.05;
    const stressPenalty = this.state.lastStressTest
      ? 1 - this.clamp01(this.state.lastStressTest.recommendedRiskMultiplier)
      : 0;
    const rawMultiplier = 1 - volatilityPenalty - drawdownPenalty - dailyLossPenalty - regimePenalty - stressPenalty;
    const multiplier = Math.max(0.25, Math.min(1.2, rawMultiplier));

    const basePct = this.state.config.position_size_pct_of_cash;
    const suggestedPositionPct = Math.max(3, Math.min(20, basePct * multiplier));

    const profile: DynamicRiskProfile = {
      timestamp: Date.now(),
      marketRegime: metrics.regime,
      realizedVolatility: metrics.realizedVolatility,
      maxDrawdownPct: metrics.maxDrawdownPct,
      sharpeLike: metrics.sharpeLike,
      multiplier,
      suggestedPositionPct,
    };
    this.state.lastRiskProfile = profile;
    return profile;
  }

  private async buildSymbolToolContext(
    symbol: string,
    isCrypto: boolean,
    broker: BrokerProviders
  ): Promise<SymbolToolContext | null> {
    const instrument = isCrypto ? normalizeCryptoSymbol(symbol) : symbol;

    try {
      const [bars, snapshot] = await Promise.all([
        broker.marketData.getBars(instrument, "1Day", { limit: 60 }).catch(() => []),
        isCrypto
          ? broker.marketData.getCryptoSnapshot(instrument).catch(() => null)
          : broker.marketData.getSnapshot(instrument).catch(() => null),
      ]);

      const closes = (bars || []).map((bar) => bar.c).filter((value) => Number.isFinite(value));
      const technical: SymbolToolContext["technical"] = {
        rsi14: null,
        macd: null,
        macdSignal: null,
        bollingerUpper: null,
        bollingerMid: null,
        bollingerLower: null,
        trendStrength: null,
      };

      if (closes.length >= 30) {
        const recent = closes.slice(-15);
        let gains = 0;
        let losses = 0;
        for (let i = 1; i < recent.length; i += 1) {
          const delta = (recent[i] ?? 0) - (recent[i - 1] ?? 0);
          if (delta >= 0) gains += delta;
          else losses += Math.abs(delta);
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
        technical.rsi14 = 100 - 100 / (1 + rs);

        const ema12 = this.calculateEMA(closes, 12);
        const ema26 = this.calculateEMA(closes, 26);
        const macdSeries = ema12.map((value, index) => value - (ema26[index] ?? value));
        const signalSeries = this.calculateEMA(macdSeries, 9);
        technical.macd = macdSeries[macdSeries.length - 1] ?? null;
        technical.macdSignal = signalSeries[signalSeries.length - 1] ?? null;

        const bollingerWindow = closes.slice(-20);
        const mid = bollingerWindow.reduce((sum, value) => sum + value, 0) / bollingerWindow.length;
        const variance =
          bollingerWindow.reduce((sum, value) => sum + (value - mid) ** 2, 0) / Math.max(1, bollingerWindow.length);
        const stdev = Math.sqrt(Math.max(variance, 0));
        technical.bollingerMid = mid;
        technical.bollingerUpper = mid + 2 * stdev;
        technical.bollingerLower = mid - 2 * stdev;

        const first = closes[0] ?? 0;
        const last = closes[closes.length - 1] ?? first;
        technical.trendStrength = first > 0 ? (last - first) / first : 0;
      }

      const matchingSignals = this.state.signalCache.filter((signal) => signal.symbol === symbol);
      const sourceDiversity = new Set(matchingSignals.map((signal) => signal.source)).size;
      const secCatalysts = matchingSignals.filter(
        (signal) => signal.source === "sec" || signal.source_detail.toLowerCase().includes("sec")
      ).length;
      const mentionVolume = matchingSignals.reduce((sum, signal) => sum + (signal.volume || 0), 0);

      const prevClose = snapshot?.prev_daily_bar?.c ?? 0;
      const dayPrice = snapshot?.daily_bar?.c ?? snapshot?.latest_trade?.price ?? 0;
      const dailyChangePct = prevClose > 0 ? ((dayPrice - prevClose) / prevClose) * 100 : 0;
      const riskMetrics = this.computePortfolioRiskMetrics();

      return {
        technical,
        fundamental: {
          dailyChangePct,
          sourceDiversity,
          secCatalysts,
          mentionVolume,
        },
        risk: {
          portfolioVolatility: riskMetrics.realizedVolatility,
          maxDrawdownPct: riskMetrics.maxDrawdownPct,
          regime: riskMetrics.regime,
        },
      };
    } catch (error) {
      this.log("Tools", "symbol_context_error", { symbol, error: String(error) });
      return null;
    }
  }

  private formatToolContext(context: SymbolToolContext | null): string {
    if (!context) return "- tool context unavailable";
    return [
      `- technical: RSI14 ${context.technical.rsi14?.toFixed(1) ?? "n/a"}, MACD ${context.technical.macd?.toFixed(4) ?? "n/a"} vs signal ${
        context.technical.macdSignal?.toFixed(4) ?? "n/a"
      }, Bollinger [${context.technical.bollingerLower?.toFixed(2) ?? "n/a"}, ${
        context.technical.bollingerUpper?.toFixed(2) ?? "n/a"
      }]`,
      `- fundamental: daily change ${context.fundamental.dailyChangePct.toFixed(2)}%, source diversity ${
        context.fundamental.sourceDiversity
      }, SEC catalysts ${context.fundamental.secCatalysts}, mentions ${context.fundamental.mentionVolume}`,
      `- risk: portfolio vol ${(context.risk.portfolioVolatility * 100).toFixed(2)}%, drawdown ${(
        context.risk.maxDrawdownPct * 100
      ).toFixed(2)}%, regime ${context.risk.regime}`,
    ].join("\n");
  }

  private async fetchLearningAdvice(
    symbol: string,
    confidence: number
  ): Promise<{ approved: boolean; adjustedConfidence: number; reasons: string[] } | null> {
    if (!this.env.LEARNING_AGENT) return null;

    try {
      const id = this.env.LEARNING_AGENT.idFromName("default");
      const stub = this.env.LEARNING_AGENT.get(id);
      const res = await stub.fetch("http://learning/advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, confidence }),
      });
      if (!res.ok) return null;

      const payload = (await res.json()) as {
        approved?: boolean;
        adjustedConfidence?: number;
        reasons?: string[];
      };
      return {
        approved: Boolean(payload.approved),
        adjustedConfidence:
          typeof payload.adjustedConfidence === "number"
            ? this.clamp01(payload.adjustedConfidence)
            : this.clamp01(confidence),
        reasons: Array.isArray(payload.reasons) ? payload.reasons.map((reason) => String(reason)) : [],
      };
    } catch (error) {
      this.log("Learning", "advice_fetch_failed", { symbol, error: String(error) });
      return null;
    }
  }

  private async fetchAnalystBatchResearch(
    signals: Array<{ symbol: string; sentiment: number }>
  ): Promise<Record<string, ResearchResult>> {
    if (!this.env.ANALYST || signals.length === 0) return {};

    try {
      const id = this.env.ANALYST.idFromName("default");
      const stub = this.env.ANALYST.get(id);
      const res = await stub.fetch("http://analyst/research-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signals: signals.slice(0, 8) }),
      });
      if (!res.ok) {
        this.log("Swarm", "analyst_batch_failed", { status: res.status });
        return {};
      }

      const payload = (await res.json()) as {
        results?: Record<
          string,
          {
            symbol?: string;
            verdict?: "BUY" | "SKIP" | "WAIT";
            confidence?: number;
            reasoning?: string;
            timestamp?: number;
          }
        >;
      };
      const sentimentBySymbol = new Map(
        signals.map((signal) => [signal.symbol.toUpperCase(), this.clampSentiment(signal.sentiment)])
      );
      const mapped: Record<string, ResearchResult> = {};
      for (const [symbolKey, value] of Object.entries(payload.results ?? {})) {
        const symbol = (value.symbol || symbolKey).toUpperCase();
        const verdict =
          value.verdict === "BUY" || value.verdict === "SKIP" || value.verdict === "WAIT" ? value.verdict : "WAIT";
        const confidence = this.clamp01(typeof value.confidence === "number" ? value.confidence : 0);
        const sentiment = sentimentBySymbol.get(symbol) ?? 0;
        mapped[symbol] = {
          symbol,
          verdict,
          confidence,
          sentiment,
          entry_quality: this.mapEntryQualityFromConfidence(confidence),
          reasoning: value.reasoning || "Swarm analyst recommendation",
          red_flags: verdict === "BUY" ? [] : ["Swarm analyst not fully confident"],
          catalysts: verdict === "BUY" ? ["Swarm analyst validation"] : [],
          timestamp: typeof value.timestamp === "number" ? value.timestamp : Date.now(),
        };
      }
      if (Object.keys(mapped).length > 0) {
        this.rememberEpisode(
          `Swarm analyst returned ${Object.keys(mapped).length} research items`,
          "success",
          ["swarm", "analyst", "research"],
          {
            impact: Math.min(1, Object.keys(mapped).length / 8),
            confidence: 0.75,
            novelty: 0.4,
          }
        );
      }
      return mapped;
    } catch (error) {
      this.log("Swarm", "analyst_batch_error", { error: String(error) });
      return {};
    }
  }

  private async syncSwarmRoleHealth(): Promise<void> {
    if (!this.env.SWARM_REGISTRY) return;

    try {
      const id = this.env.SWARM_REGISTRY.idFromName("default");
      const stub = this.env.SWARM_REGISTRY.get(id);
      const res = await stub.fetch("http://registry/agents");
      if (!res.ok) return;

      const data = (await res.json()) as Record<string, { type?: string; lastHeartbeat?: number }>;
      const now = Date.now();
      const roleHealth: AgentState["swarmRoleHealth"] = {};
      for (const status of Object.values(data)) {
        if (!status?.type) continue;
        if (
          status.type !== "scout" &&
          status.type !== "analyst" &&
          status.type !== "trader" &&
          status.type !== "risk_manager" &&
          status.type !== "learning"
        ) {
          continue;
        }
        const role = status.type as keyof AgentState["swarmRoleHealth"];
        if (typeof status.lastHeartbeat === "number" && now - status.lastHeartbeat <= 300_000) {
          roleHealth[role] = (roleHealth[role] || 0) + 1;
        }
      }
      this.state.swarmRoleHealth = roleHealth;
      this.state.lastSwarmRoleSyncAt = now;
    } catch (error) {
      this.log("Swarm", "role_health_sync_error", { error: String(error) });
    }
  }

  private getRelevantMemoryEpisodes(tags: string[], limit = 5): MemoryEpisode[] {
    this.pruneMemoryEpisodes();
    const now = Date.now();
    const normalizedTags = new Set(tags.map((tag) => tag.toLowerCase()));
    return this.state.memoryEpisodes
      .filter((episode) => episode.tags.some((tag) => normalizedTags.has(tag.toLowerCase())))
      .map((episode) => {
        const age = Math.max(0, now - episode.timestamp);
        const decay = Math.exp(-age / MEMORY_HALF_LIFE_MS);
        return { episode, score: episode.importance * decay };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.episode);
  }

  private rememberEpisode(
    context: string,
    outcome: "success" | "failure" | "neutral",
    tags: string[],
    options: {
      impact: number;
      confidence: number;
      novelty: number;
      metadata?: Record<string, unknown>;
    }
  ): void {
    const importance = this.clamp01(
      this.clamp01(options.impact) * 0.4 +
        this.clamp01(options.confidence) * 0.35 +
        this.clamp01(options.novelty) * 0.25
    );

    this.state.memoryEpisodes.push({
      id: `mem:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`,
      timestamp: Date.now(),
      importance,
      context,
      outcome,
      tags: Array.from(new Set(tags.map((tag) => tag.toLowerCase()))).slice(0, 12),
      metadata: options.metadata,
    });
    this.pruneMemoryEpisodes();
  }

  private pruneMemoryEpisodes(now = Date.now()): void {
    const threshold = now - MEMORY_RETENTION_MS;
    this.state.memoryEpisodes = (this.state.memoryEpisodes || [])
      .filter((episode) => {
        if (!episode || !Number.isFinite(episode.timestamp)) return false;
        if (episode.timestamp < threshold) return false;
        const age = now - episode.timestamp;
        const decayedImportance = episode.importance * Math.exp(-age / MEMORY_HALF_LIFE_MS);
        const isRecent = age < 3 * 24 * 60 * 60 * 1000;
        return isRecent || decayedImportance >= MEMORY_MIN_IMPORTANCE_TO_KEEP;
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MEMORY_MAX_EPISODES);
  }

  private normalizeResearchVerdict(value: unknown): "BUY" | "SKIP" | "WAIT" | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toUpperCase();
    if (normalized === "BUY" || normalized === "SKIP" || normalized === "WAIT") {
      return normalized;
    }
    return null;
  }

  private normalizeResearchEntryQuality(value: unknown): "excellent" | "good" | "fair" | "poor" | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "excellent" || normalized === "good" || normalized === "fair" || normalized === "poor") {
      return normalized;
    }
    return null;
  }

  private normalizeResearchStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 12);
    }

    if (typeof value === "string") {
      return value
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 12);
    }

    return [];
  }

  private isLlmAuthFailure(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      message.includes("authentication fails") ||
      message.includes("invalid api key") ||
      message.includes("unauthorized") ||
      message.includes("401")
    );
  }

  private logParseFailure(failure: ModelParseFailure): void {
    this.log("SignalResearch", "invalid_llm_json", {
      symbol: failure.symbol,
      stage: failure.stage,
      parser: failure.parser,
      parse_error: failure.parseError,
      response_preview: failure.responsePreview,
      recovery_applied: failure.recoveryApplied,
      fallback_verdict: failure.fallbackVerdict,
      message: "LLM returned malformed JSON; recovery parser applied.",
      severity: "warning",
      status: "warning",
      event_type: "api",
    });
  }

  private parseResearchAnalysis(
    rawContent: string,
    symbol: string,
    stage: "research_signal" | "research_crypto" = "research_signal"
  ): {
    analysis: ResearchLLMAnalysis;
    repaired: boolean;
    parseError?: string;
    responsePreview: string;
    parseFailure?: ModelParseFailure;
  } {
    const sanitized = rawContent
      .replace(/```json\s*/gi, "")
      .replace(/```/g, "")
      .replace(/\u201c|\u201d/g, '"')
      .replace(/\u2018|\u2019/g, "'")
      .trim();
    const firstBrace = sanitized.indexOf("{");
    const lastBrace = sanitized.lastIndexOf("}");
    const objectCandidate =
      firstBrace >= 0 && lastBrace > firstBrace ? sanitized.slice(firstBrace, lastBrace + 1).trim() : sanitized;
    const responsePreview = objectCandidate.slice(0, 320);

    const parseCandidates = [
      objectCandidate,
      objectCandidate.replace(/,\s*([}\]])/g, "$1"),
      objectCandidate.replace(/\r?\n/g, " "),
      objectCandidate.replace(/\r?\n/g, " ").replace(/,\s*([}\]])/g, "$1"),
      sanitized,
      sanitized.replace(/\r?\n/g, " "),
    ].filter((candidate) => candidate.length > 0);

    let parsed: Record<string, unknown> | null = null;
    let parseError: string | undefined;
    let usedCandidateIndex = -1;
    const seen = new Set<string>();

    for (let i = 0; i < parseCandidates.length; i++) {
      const candidate = parseCandidates[i]!;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const value = JSON.parse(candidate) as unknown;
        if (this.isRecord(value)) {
          parsed = value;
          usedCandidateIndex = i;
          break;
        }
      } catch (error) {
        parseError = String(error);
      }
    }

    if (!parsed) {
      const fallbackVerdict: "WAIT" = "WAIT";
      return {
        analysis: {
          verdict: fallbackVerdict,
          confidence: 0.35,
          entry_quality: "fair",
          reasoning: `LLM response for ${symbol} was not valid JSON. Applied conservative WAIT fallback.`,
          red_flags: ["LLM response parse failure"],
          catalysts: [],
        },
        repaired: true,
        parseError,
        responsePreview,
        parseFailure: {
          stage,
          symbol,
          parser: "json-recovery",
          parseError: parseError ?? null,
          responsePreview,
          recoveryApplied: true,
          fallbackVerdict,
        },
      };
    }

    const inferredVerdict = this.normalizeResearchVerdict(parsed.verdict);
    const upperContent = objectCandidate.toUpperCase();
    const verdict =
      inferredVerdict ??
      (/\bBUY\b/.test(upperContent)
        ? "BUY"
        : /\bSKIP\b/.test(upperContent)
          ? "SKIP"
          : /\bWAIT\b/.test(upperContent)
            ? "WAIT"
            : "WAIT");

    const confidenceRaw =
      typeof parsed.confidence === "number"
        ? parsed.confidence
        : typeof parsed.confidence === "string"
          ? Number(parsed.confidence)
          : Number.NaN;
    const confidence = Number.isFinite(confidenceRaw) ? this.clamp01(confidenceRaw) : 0.35;

    const entryQuality = this.normalizeResearchEntryQuality(parsed.entry_quality) ?? "fair";

    const reasoning =
      typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0
        ? parsed.reasoning.trim()
        : `LLM response for ${symbol} did not include valid structured reasoning.`;

    const redFlags = this.normalizeResearchStringArray(parsed.red_flags);
    const catalysts = this.normalizeResearchStringArray(parsed.catalysts);
    const repaired =
      usedCandidateIndex > 0 ||
      inferredVerdict === null ||
      this.normalizeResearchEntryQuality(parsed.entry_quality) === null ||
      !(typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0);

    if (repaired && !redFlags.includes("Recovered from malformed LLM JSON response")) {
      redFlags.push("Recovered from malformed LLM JSON response");
    }

    return {
      analysis: {
        verdict,
        confidence,
        entry_quality: entryQuality,
        reasoning,
        red_flags: redFlags,
        catalysts,
      },
      repaired,
      parseError,
      responsePreview,
      parseFailure: repaired
        ? {
            stage,
            symbol,
            parser: "json-recovery",
            parseError: parseError ?? null,
            responsePreview,
            recoveryApplied: true,
            fallbackVerdict: verdict,
          }
        : undefined,
    };
  }

  private async researchSignal(
    symbol: string,
    sentimentScore: number,
    sources: string[]
  ): Promise<ResearchResult | null> {
    if (!this._llm) {
      this.log("SignalResearch", "skipped_no_llm", { symbol, reason: "LLM Provider not configured" });
      return null;
    }

    if (this.state.lastLLMAuthError && Date.now() - this.state.lastLLMAuthError.at < 300_000) {
      return null; // Silent skip
    }

    const cached = this.state.signalResearch[symbol];
    const CACHE_TTL_MS = 180_000;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached;
    }

    try {
      const broker = createBrokerProviders(this.env, this.state.config.broker);
      const brokerSymbol = this.normalizeResearchSymbolForBroker(symbol, broker.broker);
      if (!brokerSymbol) {
        this.log("SignalResearch", "symbol_skipped_for_broker", { symbol, broker: broker.broker });
        return null;
      }

      const cached = tickerCache.getCachedValidation(brokerSymbol);
      if (cached === false) {
        this.log("SignalResearch", "symbol_not_tradable", { symbol: brokerSymbol, broker: broker.broker });
        return null;
      }
      if (cached === undefined) {
        const isTradable = await tickerCache.validateWithBroker(brokerSymbol, broker);
        if (!isTradable) {
          this.log("SignalResearch", "symbol_not_tradable", {
            symbol: brokerSymbol,
            broker: broker.broker,
            source: "broker_check",
          });
          return null;
        }
      }

      const isCrypto = isCryptoSymbol(brokerSymbol, this.state.config.crypto_symbols || []);
      let price = 0;
      if (isCrypto) {
        const normalized = normalizeCryptoSymbol(brokerSymbol);
        const snapshot = await broker.marketData.getCryptoSnapshot(normalized).catch((error) => {
          this.log("SignalResearch", "snapshot_fetch_failed", {
            symbol: normalized,
            broker: broker.broker,
            error: String(error),
          });
          return null;
        });
        if (!snapshot) {
          this.log("SignalResearch", "snapshot_unavailable", { symbol: normalized, broker: broker.broker });
          return null;
        }
        price =
          snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || snapshot?.latest_quote?.bid_price || 0;
      } else {
        const snapshot = await broker.marketData.getSnapshot(brokerSymbol).catch((error) => {
          this.log("SignalResearch", "snapshot_fetch_failed", {
            symbol: brokerSymbol,
            broker: broker.broker,
            error: String(error),
          });
          return null;
        });
        if (!snapshot) {
          this.log("SignalResearch", "snapshot_unavailable", { symbol: brokerSymbol, broker: broker.broker });
          return null;
        }
        if (!this.validateMarketData(snapshot)) {
          this.log("SignalResearch", "stale_data", { symbol: brokerSymbol });
          return null;
        }
        price =
          snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || snapshot?.latest_quote?.bid_price || 0;
      }

      const toolContext = await this.buildSymbolToolContext(brokerSymbol, isCrypto, broker);
      const toolSummary = this.formatToolContext(toolContext);
      const matchingSignal = this.state.signalCache.find(
        (signal) => this.normalizeResearchSymbolForBroker(signal.symbol, broker.broker) === brokerSymbol
      );
      const predictiveScore = this.predictSignalProbability({
        symbol: brokerSymbol,
        sentiment: matchingSignal?.sentiment ?? sentimentScore,
        freshness: matchingSignal?.freshness ?? 0.5,
        volume: matchingSignal?.volume ?? 1,
        sourceDiversity: new Set(
          this.state.signalCache
            .filter((signal) => this.normalizeResearchSymbolForBroker(signal.symbol, broker.broker) === brokerSymbol)
            .map((signal) => signal.source)
        ).size,
      });
      const memorySummary = this.getRelevantMemoryEpisodes([symbol, "research", "risk"], 3)
        .map(
          (episode) =>
            `- [${episode.outcome}] ${episode.context} (importance ${(episode.importance * 100).toFixed(0)}%)`
        )
        .join("\n");
      const learningAdvice = await this.fetchLearningAdvice(symbol, Math.max(0, Math.min(1, sentimentScore)));

      const prompt = `Should we BUY this ${isCrypto ? "crypto" : "stock"} based on social sentiment and fundamentals?

                      SYMBOL: ${brokerSymbol}
                      SENTIMENT: ${(sentimentScore * 100).toFixed(0)}% bullish (sources: ${sources.join(", ")})

                      CURRENT DATA:
                      - Price: $${price}

                      TOOL OUTPUT:
                      ${toolSummary}

                      PREDICTIVE EDGE:
                      - model_probability: ${(predictiveScore * 100).toFixed(1)}%
                      - model_samples: ${this.state.predictiveModel.samples}

                      MEMORY LESSONS:
                      ${memorySummary || "- No relevant memory episodes yet"}

                      LEARNING ADVICE:
                      ${
                        learningAdvice
                          ? `- approved: ${learningAdvice.approved}
                      - adjusted_confidence: ${learningAdvice.adjustedConfidence.toFixed(2)}
                      - reasons: ${learningAdvice.reasons.join("; ") || "none"}`
                          : "- unavailable"
                      }

                      Evaluate if this is a good entry. Consider: Is the sentiment justified? Is it too late (already pumped)? Any red flags?

                      JSON response:
                      {
                        "verdict": "BUY|SKIP|WAIT",
                        "confidence": 0.0-1.0,
                        "entry_quality": "excellent|good|fair|poor",
                        "reasoning": "brief reason",
                        "red_flags": ["any concerns"],
                        "catalysts": ["positive factors"]
                      }`;

      const response = await this._llm.complete({
        model: this.state.config.llm_model,
        messages: [
          {
            role: "system",
            content: "You are a stock research analyst. Be skeptical of hype. Output valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 250,
        temperature: 0,
        response_format: { type: "json_object" },
      });

      const usage = response.usage;
      if (usage) {
        this.trackLLMCost(response.model || this.state.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
        this.log("SignalResearch", "llm_usage", {
          symbol,
          model: response.model || this.state.config.llm_model,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          event_type: "api",
        });
      }

      const parsedAnalysis = this.parseResearchAnalysis(response.content || "{}", brokerSymbol);
      if (parsedAnalysis.parseFailure) {
        this.logParseFailure(parsedAnalysis.parseFailure);
      }
      const analysis = parsedAnalysis.analysis;

      const confidenceWithPrediction = this.clamp01(analysis.confidence * 0.75 + predictiveScore * 0.25);
      const adjustedConfidence = this.clamp01(
        learningAdvice ? (confidenceWithPrediction + learningAdvice.adjustedConfidence) / 2 : confidenceWithPrediction
      );

      const adjustedVerdict =
        learningAdvice && !learningAdvice.approved && analysis.verdict === "BUY" ? ("WAIT" as const) : analysis.verdict;
      const mergedRedFlags = [...(analysis.red_flags || [])];
      if (learningAdvice && !learningAdvice.approved) {
        mergedRedFlags.push(`LearningAgent rejected entry: ${learningAdvice.reasons.join("; ") || "risk caution"}`);
      }
      const mergedCatalysts = [...(analysis.catalysts || [])];
      if (learningAdvice && learningAdvice.approved && learningAdvice.reasons.length > 0) {
        mergedCatalysts.push(`LearningAgent: ${learningAdvice.reasons.join("; ")}`);
      }

      const result: ResearchResult = {
        symbol: brokerSymbol,
        verdict: adjustedVerdict,
        confidence: adjustedConfidence,
        sentiment: this.clampSentiment(sentimentScore),
        entry_quality: analysis.entry_quality,
        reasoning: analysis.reasoning,
        red_flags: mergedRedFlags,
        catalysts: mergedCatalysts,
        timestamp: Date.now(),
      };

      this.state.signalResearch[brokerSymbol] = result;
      this.log("SignalResearch", "signal_researched", {
        symbol: brokerSymbol,
        verdict: result.verdict,
        confidence: result.confidence,
        quality: result.entry_quality,
      });

      if (result.verdict === "BUY") {
        await this.sendDiscordNotification("research", {
          symbol: result.symbol,
          verdict: result.verdict,
          confidence: result.confidence,
          quality: result.entry_quality,
          sentiment: sentimentScore,
          sources,
          reasoning: result.reasoning,
          catalysts: result.catalysts,
          red_flags: result.red_flags,
        });
      }

      this.rememberEpisode(
        `Research verdict for ${brokerSymbol}: ${result.verdict} (${(result.confidence * 100).toFixed(0)}%)`,
        result.verdict === "BUY" ? "success" : "neutral",
        ["research", brokerSymbol, ...(result.verdict === "BUY" ? ["entry_candidate"] : [])],
        {
          impact: Math.min(1, Math.abs(sentimentScore)),
          confidence: result.confidence,
          novelty: 0.4,
          metadata: {
            verdict: result.verdict,
            entryQuality: result.entry_quality,
            sources,
            predictiveScore,
          },
        }
      );

      return result;
    } catch (error) {
      const errorMsg = String(error);
      if (this.isLlmAuthFailure(errorMsg)) {
        this.state.lastLLMAuthError = { at: Date.now(), message: errorMsg };
        this.log("SignalResearch", "auth_error", {
          symbol,
          message: "ACTION REQUIRED: Invalid LLM API Key. Research disabled for 5 minutes.",
          details: errorMsg,
        });
        return null;
      }
      this.log("SignalResearch", "error", { symbol, message: errorMsg });
      return null;
    }
  }

  private async researchTopSignals(limit = 5): Promise<ResearchResult[]> {
    const startedAt = Date.now();
    const llmCallsBefore = this.state.costTracker.calls;
    if (this.state.lastLLMAuthError && Date.now() - this.state.lastLLMAuthError.at < 300_000) {
      this.log("SignalResearch", "research_skipped_circuit_breaker", {
        reason: "Recent auth error",
        time_remaining_ms: 300_000 - (Date.now() - this.state.lastLLMAuthError.at),
      });
      this.recordPerformanceSample("research", Date.now() - startedAt, true);
      return [];
    }

    const broker = createBrokerProviders(this.env, this.state.config.broker);
    const positions = await broker.trading.getPositions();
    const heldSymbols = new Set(positions.map((p) => p.symbol));
    for (const sym of Object.keys(this.state.positionEntries)) {
      heldSymbols.add(sym);
    }

    const allSignals = this.state.signalCache;
    const notHeld = allSignals.filter((s) => !heldSymbols.has(s.symbol));
    const brokerCandidates = notHeld
      .map((signal) => {
        const normalizedSymbol = this.normalizeResearchSymbolForBroker(signal.symbol, broker.broker);
        if (!normalizedSymbol) return null;
        if (normalizedSymbol === signal.symbol) return signal;
        return {
          ...signal,
          symbol: normalizedSymbol,
        };
      })
      .filter((signal): signal is Signal => signal !== null);

    const brokerFilteredOut = Math.max(0, notHeld.length - brokerCandidates.length);
    if (brokerFilteredOut > 0) {
      this.log("SignalResearch", "candidates_filtered_by_broker", {
        broker: broker.broker,
        filtered_out: brokerFilteredOut,
        candidate_count: brokerCandidates.length,
      });
    }

    const tradableCandidates: Signal[] = [];
    let untradableFilteredOut = 0;

    for (const signal of brokerCandidates) {
      const cached = tickerCache.getCachedValidation(signal.symbol);
      if (cached === false) {
        untradableFilteredOut += 1;
        continue;
      }

      if (cached === undefined) {
        const isTradable = await tickerCache.validateWithBroker(signal.symbol, broker);
        if (!isTradable) {
          untradableFilteredOut += 1;
          continue;
        }
      }

      tradableCandidates.push(signal);
    }

    if (untradableFilteredOut > 0) {
      this.log("SignalResearch", "candidates_filtered_untradable", {
        broker: broker.broker,
        filtered_out: untradableFilteredOut,
        candidate_count: tradableCandidates.length,
      });
    }

    // Use raw_sentiment for threshold (before weighting), weighted sentiment for sorting
    let eligibleSignals = tradableCandidates.filter((s) => s.raw_sentiment >= this.state.config.min_sentiment_score);

    if (eligibleSignals.length === 0 && broker.broker === "okx") {
      // OKX research should still progress even during low-momentum periods.
      eligibleSignals = tradableCandidates
        .filter((signal) => isCryptoSymbol(signal.symbol, this.state.config.crypto_symbols || []))
        .sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))
        .slice(0, Math.max(limit, 3));

      if (eligibleSignals.length > 0) {
        this.log("SignalResearch", "threshold_relaxed_for_okx", {
          broker: broker.broker,
          count: eligibleSignals.length,
          min_sentiment: this.state.config.min_sentiment_score,
        });
      }
    }

    if (eligibleSignals.length === 0) {
      this.log("SignalResearch", "no_candidates_for_broker", {
        broker: broker.broker,
        total_signals: allSignals.length,
        not_held: notHeld.length,
        broker_candidates: tradableCandidates.length,
        min_sentiment: this.state.config.min_sentiment_score,
      });
      this.recordPerformanceSample("research", Date.now() - startedAt, false);
      return [];
    }

    const aggregated = new Map<
      string,
      {
        symbol: string;
        totalSentiment: number;
        totalRawSentiment: number;
        mentions: number;
        freshness: number;
        sources: Set<string>;
      }
    >();

    for (const signal of eligibleSignals) {
      if (!aggregated.has(signal.symbol)) {
        aggregated.set(signal.symbol, {
          symbol: signal.symbol,
          totalSentiment: 0,
          totalRawSentiment: 0,
          mentions: 0,
          freshness: 0,
          sources: new Set<string>(),
        });
      }
      const entry = aggregated.get(signal.symbol)!;
      entry.totalSentiment += signal.sentiment;
      entry.totalRawSentiment += signal.raw_sentiment;
      entry.mentions += 1;
      entry.freshness = Math.max(entry.freshness, signal.freshness || 0);
      entry.sources.add(signal.source);
    }

    const now = Date.now();
    const enrichedCandidates = Array.from(aggregated.values()).map((entry) => {
      const avgSentiment = entry.totalSentiment / entry.mentions;
      const avgRawSentiment = entry.totalRawSentiment / entry.mentions;
      const sourceDiversity = Math.min(1, entry.sources.size / 3);
      const mentionScore = Math.min(1, Math.log2(entry.mentions + 1) / 4);
      const freshnessScore = Math.max(0, Math.min(entry.freshness, 1));
      const predictiveScore = this.predictSignalProbability({
        symbol: entry.symbol,
        sentiment: avgSentiment,
        freshness: freshnessScore,
        volume: entry.mentions,
        sourceDiversity: entry.sources.size,
      });
      const recentResearch = this.state.signalResearch[entry.symbol];
      const recentlyResearched =
        !!recentResearch &&
        Number.isFinite(recentResearch.timestamp) &&
        now - recentResearch.timestamp < 15 * 60 * 1000;
      const recentPenalty = recentlyResearched ? 0.2 : 0;

      const priority =
        avgSentiment * 0.55 +
        avgRawSentiment * 0.2 +
        sourceDiversity * 0.15 +
        mentionScore * 0.05 +
        freshnessScore * 0.05 +
        predictiveScore * 0.15 -
        recentPenalty;

      return {
        symbol: entry.symbol,
        avgSentiment,
        mentions: entry.mentions,
        freshness: freshnessScore,
        sources: entry.sources,
        sourceList: Array.from(entry.sources),
        predictiveScore,
        priority,
      };
    });

    const outlierScores = this.computeCandidateOutlierScores(
      enrichedCandidates.map((candidate) => ({
        symbol: candidate.symbol,
        sentiment: candidate.avgSentiment,
        mentions: candidate.mentions,
        freshness: candidate.freshness,
        sourceCount: candidate.sources.size,
      }))
    );

    const candidatePool = enrichedCandidates
      .filter((candidate) => {
        const score = outlierScores[candidate.symbol] ?? 0;
        return score < 2.4;
      })
      .sort((a, b) => b.priority - a.priority);

    const heldProfiles = Array.from(heldSymbols)
      .map((symbol) => {
        const symbolSignals = this.state.signalCache.filter((signal) => signal.symbol === symbol);
        if (symbolSignals.length === 0) return null;
        const mentions = symbolSignals.length;
        const sentiment = symbolSignals.reduce((sum, signal) => sum + signal.sentiment, 0) / mentions;
        const freshness = symbolSignals.reduce((max, signal) => Math.max(max, this.clamp01(signal.freshness || 0)), 0);
        const sources = new Set(symbolSignals.map((signal) => signal.source));
        return { symbol, sentiment, mentions, freshness, sources };
      })
      .filter((profile): profile is NonNullable<typeof profile> => profile !== null);

    const queued: Array<{
      symbol: string;
      avgSentiment: number;
      sources: string[];
      mentions: number;
      predictiveScore: number;
      priority: number;
      maxCorrelation: number;
    }> = [];
    const selectedProfiles: Array<{
      symbol: string;
      sentiment: number;
      mentions: number;
      freshness: number;
      sources: Set<string>;
    }> = [];

    for (const candidate of candidatePool) {
      const peers = [...heldProfiles, ...selectedProfiles];
      let maxCorrelation = 0;
      for (const peer of peers) {
        maxCorrelation = Math.max(
          maxCorrelation,
          this.computeSignalCorrelation(
            {
              sentiment: candidate.avgSentiment,
              mentions: candidate.mentions,
              freshness: candidate.freshness,
              sources: candidate.sources,
            },
            peer
          )
        );
      }

      if (maxCorrelation >= 0.82) {
        this.log("SignalResearch", "candidate_skipped_high_correlation", {
          symbol: candidate.symbol,
          max_correlation: Number(maxCorrelation.toFixed(3)),
        });
        continue;
      }

      queued.push({
        symbol: candidate.symbol,
        avgSentiment: candidate.avgSentiment,
        sources: candidate.sourceList,
        mentions: candidate.mentions,
        predictiveScore: candidate.predictiveScore,
        priority: candidate.priority,
        maxCorrelation,
      });
      selectedProfiles.push({
        symbol: candidate.symbol,
        sentiment: candidate.avgSentiment,
        mentions: candidate.mentions,
        freshness: candidate.freshness,
        sources: candidate.sources,
      });
      if (queued.length >= limit) break;
    }

    const filteredOutliers = enrichedCandidates
      .filter((candidate) => (outlierScores[candidate.symbol] ?? 0) >= 2.4)
      .map((candidate) => candidate.symbol);
    if (filteredOutliers.length > 0) {
      this.log("SignalResearch", "candidate_outliers_filtered", {
        count: filteredOutliers.length,
        symbols: filteredOutliers.slice(0, 10),
      });
    }

    if (queued.length === 0) {
      this.log("SignalResearch", "no_candidates", {
        total_signals: allSignals.length,
        not_held: notHeld.length,
        above_threshold: eligibleSignals.length,
        outlier_filtered: filteredOutliers.length,
        min_sentiment: this.state.config.min_sentiment_score,
      });
      this.recordPerformanceSample("research", Date.now() - startedAt, false);
      return [];
    }

    const maxConcurrent = Math.min(RESEARCH_MAX_CONCURRENT, queued.length);
    this.log("SignalResearch", "researching_signals", {
      count: queued.length,
      max_concurrent: maxConcurrent,
      queue: queued.map((c) => ({
        symbol: c.symbol,
        priority: Number(c.priority.toFixed(3)),
        predictive: Number(c.predictiveScore.toFixed(3)),
        mentions: c.mentions,
        corr: Number(c.maxCorrelation.toFixed(3)),
      })),
    });

    const results: ResearchResult[] = [];
    const swarmResults = await this.fetchAnalystBatchResearch(
      queued.map((candidate) => ({ symbol: candidate.symbol, sentiment: candidate.avgSentiment }))
    );
    const coveredBySwarm = new Set<string>();
    for (const result of Object.values(swarmResults)) {
      coveredBySwarm.add(result.symbol);
      this.state.signalResearch[result.symbol] = result;
      results.push(result);
    }

    const localQueue = queued.filter((candidate) => !coveredBySwarm.has(candidate.symbol));
    if (localQueue.length > 0) {
      this.log("SignalResearch", "swarm_research_partial_fallback", {
        swarm_count: coveredBySwarm.size,
        local_count: localQueue.length,
      });
    }

    for (let i = 0; i < localQueue.length; i += maxConcurrent) {
      const batch = localQueue.slice(i, i + maxConcurrent);
      const settled = await Promise.allSettled(
        batch.map((candidate) => this.researchSignal(candidate.symbol, candidate.avgSentiment, candidate.sources))
      );

      settled.forEach((result, index) => {
        const symbol = batch[index]!.symbol;
        if (result.status === "fulfilled") {
          if (result.value) {
            results.push(result.value);
          }
          return;
        }

        this.log("SignalResearch", "research_failed", {
          symbol,
          error: String(result.reason),
        });
      });

      if (i + maxConcurrent < localQueue.length) {
        await this.sleep(RESEARCH_BATCH_DELAY_MS);
      }
    }

    const llmCallsDelta = Math.max(0, this.state.costTracker.calls - llmCallsBefore);
    this.log("SignalResearch", "research_cycle_completed", {
      broker: broker.broker,
      queued: queued.length,
      resolved: results.length,
      llm_calls_delta: llmCallsDelta,
      tracked_research: Object.keys(this.state.signalResearch).length,
    });
    this.recordPerformanceSample("research", Date.now() - startedAt, false);
    return results;
  }

  private async researchPosition(
    symbol: string,
    position: Position
  ): Promise<{
    recommendation: "SELL" | "HOLD" | "ADD";
    risk_level: "low" | "medium" | "high";
    reasoning: string;
    key_factors: string[];
  } | null> {
    if (!this._llm) return null;

    const plPct = (position.unrealized_pl / (position.market_value - position.unrealized_pl)) * 100;

    const prompt = `Analyze this position for risk and opportunity:

POSITION: ${symbol}
- Shares: ${position.qty}
- Market Value: $${position.market_value.toFixed(2)}
- P&L: $${position.unrealized_pl.toFixed(2)} (${plPct.toFixed(1)}%)
- Current Price: $${position.current_price}

Provide a brief risk assessment and recommendation (HOLD, SELL, or ADD). JSON format:
{
  "recommendation": "HOLD|SELL|ADD",
  "risk_level": "low|medium|high",
  "reasoning": "brief reason",
  "key_factors": ["factor1", "factor2"]
}`;

    try {
      const response = await this._llm.complete({
        model: this.state.config.llm_model,
        messages: [
          { role: "system", content: "You are a position risk analyst. Be concise. Output valid JSON only." },
          { role: "user", content: prompt },
        ],
        max_tokens: 200,
        temperature: 0, // Task 2: Deterministic
        seed: 42, // Task 2: Deterministic
        response_format: { type: "json_object" },
      });

      const usage = response.usage;
      if (usage) {
        this.trackLLMCost(response.model || this.state.config.llm_model, usage.prompt_tokens, usage.completion_tokens);
      }

      const content = response.content || "{}";
      const analysis = JSON.parse(content.replace(/```json\n?|```/g, "").trim()) as {
        recommendation: "HOLD" | "SELL" | "ADD";
        risk_level: "low" | "medium" | "high";
        reasoning: string;
        key_factors: string[];
      };

      this.state.positionResearch[symbol] = { ...analysis, timestamp: Date.now() };
      this.log("PositionResearch", "position_analyzed", {
        symbol,
        recommendation: analysis.recommendation,
        risk: analysis.risk_level,
      });

      return analysis;
    } catch (error) {
      this.log("PositionResearch", "error", { symbol, message: String(error) });
      return null;
    }
  }

  private async analyzeSignalsWithLLM(
    signals: Signal[],
    positions: Position[],
    account: Account
  ): Promise<{
    decision_id: string | null;
    recommendations: Array<{
      action: "BUY" | "SELL" | "HOLD";
      symbol: string;
      confidence: number;
      reasoning: string;
      suggested_size_pct?: number;
    }>;
    market_summary: string;
    high_conviction: string[];
  }> {
    if (!this._llm || signals.length === 0) {
      return { decision_id: null, recommendations: [], market_summary: "No signals to analyze", high_conviction: [] };
    }

    const aggregated = new Map<string, { symbol: string; sources: string[]; totalSentiment: number; count: number }>();
    for (const sig of signals) {
      if (!aggregated.has(sig.symbol)) {
        aggregated.set(sig.symbol, { symbol: sig.symbol, sources: [], totalSentiment: 0, count: 0 });
      }
      const agg = aggregated.get(sig.symbol)!;
      agg.sources.push(sig.source);
      agg.totalSentiment += sig.sentiment;
      agg.count++;
    }

    const candidates = Array.from(aggregated.values())
      .map((a) => {
        const avgSentiment = a.totalSentiment / a.count;
        const predictiveScore = this.predictSignalProbability({
          symbol: a.symbol,
          sentiment: avgSentiment,
          freshness: 0.6,
          volume: a.count,
          sourceDiversity: new Set(a.sources).size,
        });
        return { ...a, avgSentiment, predictiveScore };
      })
      .filter((a) => a.avgSentiment >= this.state.config.min_sentiment_score * 0.5)
      .sort((a, b) => b.avgSentiment + b.predictiveScore * 0.2 - (a.avgSentiment + a.predictiveScore * 0.2))
      .slice(0, 10);

    if (candidates.length === 0) {
      return {
        decision_id: null,
        recommendations: [],
        market_summary: "No candidates above threshold",
        high_conviction: [],
      };
    }

    const positionSymbols = new Set(positions.map((p) => p.symbol));
    const broker = createBrokerProviders(this.env, this.state.config.broker);
    const portfolioRisk = this.computePortfolioRiskMetrics();
    const dynamicRisk = this.getDynamicRiskProfile(account);
    const candidateToolSummaries = await Promise.all(
      candidates.slice(0, 3).map(async (candidate) => {
        const isCrypto = isCryptoSymbol(candidate.symbol, this.state.config.crypto_symbols || []);
        const toolContext = await this.buildSymbolToolContext(candidate.symbol, isCrypto, broker);
        return `- ${candidate.symbol}: ${this.formatToolContext(toolContext)}`;
      })
    );
    const memoryLessons = this.getRelevantMemoryEpisodes(["analyst", "risk", "trade"], 4)
      .map(
        (episode) => `- ${episode.context} (${episode.outcome}, importance ${(episode.importance * 100).toFixed(0)}%)`
      )
      .join("\n");

    const prompt = `Current Time: ${new Date().toISOString()}

ACCOUNT STATUS:
- Equity: $${account.equity.toFixed(2)}
- Cash: $${account.cash.toFixed(2)}
- Current Positions: ${positions.length}/${this.state.config.max_positions}

CURRENT POSITIONS:
${
  positions.length === 0
    ? "None"
    : positions
        .map((p) => {
          const entry = this.state.positionEntries[p.symbol];
          const holdMinutes = entry ? Math.round((Date.now() - entry.entry_time) / (1000 * 60)) : 0;
          const holdStr = holdMinutes >= 60 ? `${(holdMinutes / 60).toFixed(1)}h` : `${holdMinutes}m`;
          return `- ${p.symbol}: ${p.qty} shares, P&L: $${p.unrealized_pl.toFixed(2)} (${((p.unrealized_pl / (p.market_value - p.unrealized_pl)) * 100).toFixed(1)}%), held ${holdStr}`;
        })
        .join("\n")
}

TOP SENTIMENT CANDIDATES:
${candidates
  .map(
    (c) =>
      `- ${c.symbol}: avg sentiment ${(c.avgSentiment * 100).toFixed(0)}%, predictive ${(c.predictiveScore * 100).toFixed(0)}%, sources: ${c.sources.join(", ")}, ${positionSymbols.has(c.symbol) ? "[CURRENTLY HELD]" : "[NOT HELD]"}`
  )
  .join("\n")}

RAW SIGNALS (top 20):
${signals
  .slice(0, 20)
  .map((s) => `- ${s.symbol} (${s.source}): ${s.reason}`)
  .join("\n")}

TOOL CONTEXT (TOP CANDIDATES):
${candidateToolSummaries.join("\n")}

PORTFOLIO RISK CONTEXT:
- Regime: ${dynamicRisk.marketRegime}
- Regime confidence: ${(this.state.marketRegime.confidence * 100).toFixed(0)}%
- Regime duration (min): ${(this.state.marketRegime.duration / 60000).toFixed(1)}
- Realized volatility: ${(dynamicRisk.realizedVolatility * 100).toFixed(2)}%
- Max drawdown: ${(dynamicRisk.maxDrawdownPct * 100).toFixed(2)}%
- Sharpe-like: ${portfolioRisk.sharpeLike.toFixed(3)}
- Dynamic multiplier: ${dynamicRisk.multiplier.toFixed(2)}
- Suggested position pct: ${dynamicRisk.suggestedPositionPct.toFixed(2)}%
- Stress test passed: ${this.state.lastStressTest ? this.state.lastStressTest.passed : "n/a"}
- Stress worst-case drawdown: ${this.state.lastStressTest ? (this.state.lastStressTest.worstCaseDrawdownPct * 100).toFixed(2) : "n/a"}%

EPISODIC MEMORY LESSONS:
${memoryLessons || "- No major memory episodes yet"}

TRADING RULES:
- Max position size: $${this.state.config.max_position_value}
- Take profit target: ${this.state.config.take_profit_pct}%
- Stop loss: ${this.state.config.stop_loss_pct}%
- Min confidence to trade: ${this.state.config.min_analyst_confidence}
- Min hold time before selling: ${this.state.config.llm_min_hold_minutes ?? 30} minutes

Analyze and provide BUY/SELL/HOLD recommendations:`;

    try {
      const temperature = 0;
      const response = await this._llm.complete({
        model: this.state.config.llm_analyst_model,
        messages: [
          {
            role: "system",
            content: `You are a senior trading analyst AI. Make the FINAL trading decisions based on social sentiment signals.

Rules:
- Only recommend BUY for symbols with strong conviction from multiple data points
- Recommend SELL only for positions that have been held long enough AND show deteriorating sentiment or major red flags
- Give positions time to develop - avoid selling too early just because gains are small
- Positions held less than 1-2 hours should generally be given more time unless hitting stop loss
- Consider the QUALITY of sentiment, not just quantity
- Output valid JSON only

Response format:
{
  "recommendations": [
    { "action": "BUY"|"SELL"|"HOLD", "symbol": "TICKER", "confidence": 0.0-1.0, "reasoning": "detailed reasoning", "suggested_size_pct": 10-30 }
  ],
  "market_summary": "overall market read and sentiment",
  "high_conviction_plays": ["symbols you feel strongest about"]
}`,
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 800,
        temperature,
        response_format: { type: "json_object" },
      });

      const usage = response.usage;
      if (usage) {
        this.trackLLMCost(
          response.model || this.state.config.llm_analyst_model,
          usage.prompt_tokens,
          usage.completion_tokens
        );
      }

      const content = response.content || "{}";
      const analysis = JSON.parse(content.replace(/```json\n?|```/g, "").trim()) as {
        recommendations: Array<{
          action: "BUY" | "SELL" | "HOLD";
          symbol: string;
          confidence: number;
          reasoning: string;
          suggested_size_pct?: number;
        }>;
        market_summary: string;
        high_conviction_plays?: string[];
      };

      this.log("Analyst", "analysis_complete", {
        candidates: candidates.length,
        recommendations: analysis.recommendations?.length || 0,
      });

      this.rememberEpisode(
        `LLM batch analysis produced ${analysis.recommendations?.length || 0} recommendations`,
        "neutral",
        ["analyst", "batch_decision", dynamicRisk.marketRegime],
        {
          impact: Math.min(1, candidates.length / 10),
          confidence: this.clamp01(
            (analysis.recommendations || []).reduce((acc, rec) => acc + (Number(rec.confidence) || 0), 0) /
              Math.max(1, (analysis.recommendations || []).length)
          ),
          novelty: 0.35,
          metadata: {
            highConviction: analysis.high_conviction_plays || [],
            marketSummary: analysis.market_summary || "",
          },
        }
      );

      let decisionId: string | null = null;
      try {
        const db = createD1Client(this.env.DB);
        decisionId = await createDecision(db, {
          source: "harness",
          kind: "signal_batch_analysis",
          model: this.state.config.llm_analyst_model,
          temperature,
          input: {
            now: new Date().toISOString(),
            broker: this.state.config.broker,
            account: { equity: account.equity, cash: account.cash },
            positions: positions.map((p) => ({
              symbol: p.symbol,
              qty: p.qty,
              market_value: p.market_value,
              unrealized_pl: p.unrealized_pl,
            })),
            candidates,
            signals: signals.slice(0, 20).map((s) => ({
              symbol: s.symbol,
              source: s.source,
              sentiment: s.sentiment,
              volume: s.volume,
              reason: s.reason,
            })),
            rules: {
              max_position_value: this.state.config.max_position_value,
              take_profit_pct: this.state.config.take_profit_pct,
              stop_loss_pct: this.state.config.stop_loss_pct,
              min_analyst_confidence: this.state.config.min_analyst_confidence,
              llm_min_hold_minutes: this.state.config.llm_min_hold_minutes ?? 30,
            },
          },
          output: {
            recommendations: analysis.recommendations || [],
            market_summary: analysis.market_summary || "",
            high_conviction_plays: analysis.high_conviction_plays || [],
          },
        });
      } catch (error) {
        this.log("Analyst", "decision_persist_failed", { message: String(error) });
      }

      return {
        decision_id: decisionId,
        recommendations: analysis.recommendations || [],
        market_summary: analysis.market_summary || "",
        high_conviction: analysis.high_conviction_plays || [],
      };
    } catch (error) {
      this.log("Analyst", "error", { message: String(error) });
      return {
        decision_id: null,
        recommendations: [],
        market_summary: `Analysis failed: ${error}`,
        high_conviction: [],
      };
    }
  }

  // ============================================================================
  // SECTION 7: ANALYST & TRADING LOGIC
  // ============================================================================
  // [CUSTOMIZABLE] Core trading decision logic lives here.
  //
  // runAnalyst(): Main trading loop - checks exits, then looks for entries
  // executeBuy(): Position sizing and order execution
  // executeSell(): Closes positions with reason logging
  //
  // [TUNE] Position sizing formula in executeBuy()
  // [TUNE] Entry/exit conditions in runAnalyst()
  // ============================================================================

  private async runAnalyst(): Promise<void> {
    const broker = createBrokerProviders(this.env, this.state.config.broker);

    const [account, positions, clock] = await Promise.all([
      broker.trading.getAccount(),
      broker.trading.getPositions(),
      broker.trading.getClock(),
    ]);

    if (!account || !clock.is_open) {
      this.log("System", "analyst_skipped", { reason: "Account unavailable or market closed" });
      return;
    }

    const riskProfile = this.getDynamicRiskProfile(account);
    if (!this.state.lastStressTest || Date.now() - this.state.lastStressTest.timestamp >= STRESS_TEST_INTERVAL_MS) {
      this.runStressTest(account, positions);
    }
    const stressFailed = !!this.state.lastStressTest && !this.state.lastStressTest.passed;
    this.log("Risk", "dynamic_profile", {
      regime: riskProfile.marketRegime,
      volatility: Number((riskProfile.realizedVolatility * 100).toFixed(2)),
      drawdown_pct: Number((riskProfile.maxDrawdownPct * 100).toFixed(2)),
      multiplier: Number(riskProfile.multiplier.toFixed(3)),
      suggested_pct: Number(riskProfile.suggestedPositionPct.toFixed(2)),
      stress_passed: this.state.lastStressTest?.passed ?? null,
    });

    const heldSymbols = new Set(positions.map((p) => p.symbol));

    // Check position exits
    for (const pos of positions) {
      if (pos.asset_class === "us_option") continue; // Options handled separately
      if (isCryptoSymbol(pos.symbol, this.state.config.crypto_symbols || [])) continue;

      const entry = this.state.positionEntries[pos.symbol];
      if (entry) {
        entry.peak_price = Math.max(entry.peak_price || 0, pos.current_price || 0);
      }
      const plPct = this.estimatePositionPnLPct(pos, entry);
      const thresholds = this.computeAdaptiveExitThresholds(riskProfile, pos, entry);

      // Take profit
      if (plPct >= thresholds.takeProfitPct) {
        await this.executeSell(
          broker,
          pos.symbol,
          `Take profit at +${plPct.toFixed(1)}% (target ${thresholds.takeProfitPct.toFixed(1)}%)`
        );
        continue;
      }

      // Stop loss
      if (plPct <= -thresholds.stopLossPct) {
        await this.executeSell(
          broker,
          pos.symbol,
          `Stop loss at ${plPct.toFixed(1)}% (limit -${thresholds.stopLossPct.toFixed(1)}%)`
        );
        continue;
      }

      if (plPct > 0 && thresholds.peakDrawdownPct <= -thresholds.trailingStopPct) {
        await this.executeSell(
          broker,
          pos.symbol,
          `Trailing stop at ${thresholds.peakDrawdownPct.toFixed(1)}% from peak (limit -${thresholds.trailingStopPct.toFixed(1)}%)`
        );
        continue;
      }

      // Check staleness
      if (this.state.config.stale_position_enabled) {
        const stalenessResult = this.analyzeStaleness(pos.symbol, pos.current_price, 0);
        this.state.stalenessAnalysis[pos.symbol] = stalenessResult;

        if (stalenessResult.isStale) {
          await this.executeSell(broker, pos.symbol, `STALE: ${stalenessResult.reason}`);
        }
      }
    }

    if (positions.length < this.state.config.max_positions && this.state.signalCache.length > 0) {
      const researchedBuys = Object.values(this.state.signalResearch)
        .filter((r) => r.verdict === "BUY" && r.confidence >= this.state.config.min_analyst_confidence)
        .filter((r) => !heldSymbols.has(r.symbol))
        .sort((a, b) => b.confidence - a.confidence);

      for (const research of researchedBuys.slice(0, 3)) {
        if (positions.length >= this.state.config.max_positions) break;
        if (heldSymbols.has(research.symbol)) continue;

        const originalSignal = this.state.signalCache.find((s) => s.symbol === research.symbol);
        let finalConfidence = research.confidence;

        if (this.isTwitterEnabled() && originalSignal) {
          const twitterConfirm = await this.gatherTwitterConfirmation(research.symbol, originalSignal.sentiment);
          if (twitterConfirm?.confirms_existing) {
            finalConfidence = Math.min(1.0, finalConfidence * 1.15);
            this.log("System", "twitter_boost", { symbol: research.symbol, new_confidence: finalConfidence });
          } else if (twitterConfirm && !twitterConfirm.confirms_existing && twitterConfirm.sentiment !== 0) {
            finalConfidence = finalConfidence * 0.85;
          }
        }
        finalConfidence = this.applyRegimeConfidenceAdjustment(
          finalConfidence,
          originalSignal?.sentiment || finalConfidence
        );

        if (finalConfidence < this.state.config.min_analyst_confidence) continue;
        if (stressFailed && finalConfidence < 0.85) {
          this.log("Risk", "buy_deferred_stress_regime", {
            symbol: research.symbol,
            confidence: finalConfidence,
            worst_case_drawdown_pct: this.state.lastStressTest
              ? Number((this.state.lastStressTest.worstCaseDrawdownPct * 100).toFixed(2))
              : null,
          });
          continue;
        }
        const corrCheck = this.shouldBlockCorrelatedTrade(research.symbol, heldSymbols);
        if (corrCheck.blocked) {
          this.log("Risk", "buy_deferred_signal_correlation", {
            symbol: research.symbol,
            with_symbol: corrCheck.peer,
            correlation: Number(corrCheck.maxCorrelation.toFixed(3)),
          });
          continue;
        }

        const shouldUseOptions =
          this.isOptionsEnabled() &&
          finalConfidence >= this.state.config.options_min_confidence &&
          research.entry_quality === "excellent";

        if (shouldUseOptions) {
          const contract = await this.findBestOptionsContract(research.symbol, "bullish", account.equity);
          if (contract) {
            const optionsResult = await this.executeOptionsOrder(contract, 1, account.equity);
            if (optionsResult) {
              this.log("System", "options_position_opened", { symbol: research.symbol, contract: contract.symbol });
            }
          }
        }

        const result = await this.executeBuy(broker, research.symbol, finalConfidence, account);
        if (result) {
          heldSymbols.add(research.symbol);
          const predicted = this.predictSignalProbability({
            symbol: research.symbol,
            sentiment: originalSignal?.sentiment ?? finalConfidence,
            freshness: originalSignal?.freshness ?? 0.5,
            volume: originalSignal?.volume ?? 1,
            sourceDiversity: new Set(
              this.state.signalCache.filter((s) => s.symbol === research.symbol).map((s) => s.source)
            ).size,
          });
          this.state.positionEntries[research.symbol] = {
            symbol: research.symbol,
            entry_time: Date.now(),
            entry_price: 0,
            entry_sentiment: originalSignal?.sentiment || finalConfidence,
            entry_social_volume: originalSignal?.volume || 0,
            entry_sources: originalSignal?.subreddits || [originalSignal?.source || "research"],
            entry_reason: research.reasoning,
            peak_price: 0,
            peak_sentiment: originalSignal?.sentiment || finalConfidence,
            entry_prediction: predicted,
            entry_regime: this.state.marketRegime.type,
          };
        }
      }

      const analysis = await this.analyzeSignalsWithLLM(this.state.signalCache, positions, account);
      const decisionId = analysis.decision_id ?? undefined;
      const researchedSymbols = new Set(researchedBuys.map((r) => r.symbol));

      for (const rec of analysis.recommendations) {
        if (rec.confidence < this.state.config.min_analyst_confidence) continue;

        if (rec.action === "SELL" && heldSymbols.has(rec.symbol)) {
          const entry = this.state.positionEntries[rec.symbol];
          const holdMinutes = entry ? (Date.now() - entry.entry_time) / (1000 * 60) : 0;
          const minHoldMinutes = this.state.config.llm_min_hold_minutes ?? 30;

          if (holdMinutes < minHoldMinutes) {
            this.log("Analyst", "llm_sell_blocked", {
              symbol: rec.symbol,
              holdMinutes: Math.round(holdMinutes),
              minRequired: minHoldMinutes,
              reason: "Position held less than minimum hold time",
            });
            continue;
          }

          const result = await this.executeSell(broker, rec.symbol, `LLM recommendation: ${rec.reasoning}`, decisionId);
          if (result) {
            heldSymbols.delete(rec.symbol);
            this.log("Analyst", "llm_sell_executed", {
              symbol: rec.symbol,
              confidence: rec.confidence,
              reasoning: rec.reasoning,
            });
          }
          continue;
        }

        if (rec.action === "BUY") {
          if (positions.length >= this.state.config.max_positions) continue;
          if (heldSymbols.has(rec.symbol)) continue;
          if (researchedSymbols.has(rec.symbol)) continue;
          const adjustedRecConfidence = this.applyRegimeConfidenceAdjustment(rec.confidence, rec.confidence);
          if (stressFailed && adjustedRecConfidence < 0.9) continue;
          if (adjustedRecConfidence < this.state.config.min_analyst_confidence) continue;
          const corrCheck = this.shouldBlockCorrelatedTrade(rec.symbol, heldSymbols);
          if (corrCheck.blocked) {
            this.log("Risk", "buy_deferred_signal_correlation", {
              symbol: rec.symbol,
              with_symbol: corrCheck.peer,
              correlation: Number(corrCheck.maxCorrelation.toFixed(3)),
            });
            continue;
          }

          const result = await this.executeBuy(broker, rec.symbol, adjustedRecConfidence, account, decisionId);
          if (result) {
            const originalSignal = this.state.signalCache.find((s) => s.symbol === rec.symbol);
            const predicted = this.predictSignalProbability({
              symbol: rec.symbol,
              sentiment: originalSignal?.sentiment ?? rec.confidence,
              freshness: originalSignal?.freshness ?? 0.5,
              volume: originalSignal?.volume ?? 1,
              sourceDiversity: new Set(
                this.state.signalCache.filter((s) => s.symbol === rec.symbol).map((s) => s.source)
              ).size,
            });
            heldSymbols.add(rec.symbol);
            this.state.positionEntries[rec.symbol] = {
              symbol: rec.symbol,
              entry_time: Date.now(),
              entry_price: 0,
              entry_sentiment: originalSignal?.sentiment || rec.confidence,
              entry_social_volume: originalSignal?.volume || 0,
              entry_sources: originalSignal?.subreddits || [originalSignal?.source || "analyst"],
              entry_reason: rec.reasoning,
              peak_price: 0,
              peak_sentiment: originalSignal?.sentiment || rec.confidence,
              entry_prediction: predicted,
              entry_regime: this.state.marketRegime.type,
            };
          }
        }
      }
    }
  }

  private getAdaptivePositionSizePct(account: Account): number {
    const risk = this.getDynamicRiskProfile(account);
    return risk.suggestedPositionPct;
  }

  private async executeBuy(
    broker: BrokerProviders,
    symbol: string,
    confidence: number,
    account: Account,
    idempotencySuffix?: string
  ): Promise<boolean> {
    if (!symbol || symbol.trim().length === 0) {
      this.log("Executor", "buy_blocked", { reason: "INVARIANT: Empty symbol" });
      return false;
    }

    if (account.cash <= 0) {
      this.log("Executor", "buy_blocked", { symbol, reason: "INVARIANT: No cash available", cash: account.cash });
      return false;
    }

    if (confidence <= 0 || confidence > 1 || !Number.isFinite(confidence)) {
      this.log("Executor", "buy_blocked", { symbol, reason: "INVARIANT: Invalid confidence", confidence });
      return false;
    }

    const isCrypto = isCryptoSymbol(symbol, this.state.config.crypto_symbols || []);
    const riskProfile = this.getDynamicRiskProfile(account);
    const symbolVolatility = await this.estimateSymbolVolatility(broker, symbol, isCrypto);
    const baseSizePct = Math.min(20, this.getAdaptivePositionSizePct(account));
    const positionScale = this.computeDynamicPositionScale(
      symbolVolatility,
      confidence,
      riskProfile.multiplier,
      riskProfile.marketRegime
    );
    const sizePct = Math.min(25, Math.max(2.5, baseSizePct * positionScale));
    const maxPositionCap = isCrypto
      ? Math.min(this.state.config.crypto_max_position_value, this.state.config.max_position_value)
      : this.state.config.max_position_value;
    const positionSize = Math.min(account.cash * (sizePct / 100), maxPositionCap);

    if (positionSize < 100) {
      this.log("Executor", "buy_skipped", { symbol, reason: "Position too small" });
      return false;
    }

    const maxAllowed = maxPositionCap * 1.01;
    if (positionSize <= 0 || positionSize > maxAllowed || !Number.isFinite(positionSize)) {
      this.log("Executor", "buy_blocked", {
        symbol,
        reason: "INVARIANT: Invalid position size",
        positionSize,
        maxAllowed,
      });
      return false;
    }

    if (this.env.RISK_MANAGER) {
      try {
        const db = createD1Client(this.env.DB);
        const [accountSnapshot, positions, clock, riskState, storedPolicy] = await Promise.all([
          broker.trading.getAccount(),
          broker.trading.getPositions(),
          broker.trading.getClock(),
          getRiskState(db),
          getPolicyConfig(db),
        ]);
        const policyConfig = storedPolicy ?? getDefaultPolicyConfig(this.env);

        const id = this.env.RISK_MANAGER.idFromName("default");
        const stub = this.env.RISK_MANAGER.get(id);
        const res = await stub.fetch("http://risk/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol,
            notional: Math.round(positionSize * 100) / 100,
            side: "buy",
            asset_class: isCrypto ? "crypto" : "us_equity",
            order_type: "market",
            time_in_force: isCrypto ? "gtc" : "day",
            account: accountSnapshot,
            positions,
            clock,
            riskState,
            policy_config: policyConfig,
            volatility: riskProfile.realizedVolatility,
            drawdownPct: riskProfile.maxDrawdownPct,
            riskMultiplier: riskProfile.multiplier,
            marketRegime: riskProfile.marketRegime,
          }),
        });

        if (res.ok) {
          const { approved, reason } = (await res.json()) as { approved: boolean; reason?: string };
          if (!approved) {
            this.log("Executor", "buy_blocked_by_risk_manager", { symbol, reason });
            return false;
          }
        } else {
          this.log("Executor", "risk_manager_http_error", {
            symbol,
            status: res.status,
            action: "blocking_buy",
          });
          return false;
        }
      } catch (e) {
        this.log("Executor", "risk_manager_unreachable", {
          symbol,
          error: String(e),
          action: "blocking_buy",
        });
        return false;
      }
    }

    try {
      const orderSymbol = isCrypto ? normalizeCryptoSymbol(symbol) : symbol;
      const timeInForce = isCrypto ? "gtc" : "day";

      if (!isCrypto) {
        const allowedExchanges = this.state.config.allowed_exchanges ?? ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"];
        if (allowedExchanges.length > 0) {
          const asset = await broker.trading.getAsset(symbol);
          if (!asset) {
            this.log("Executor", "buy_blocked", { symbol, reason: "Asset not found" });
            return false;
          }
          if (!allowedExchanges.includes(asset.exchange)) {
            this.log("Executor", "buy_blocked", {
              symbol,
              reason: "Exchange not allowed (OTC/foreign stocks have data issues)",
              exchange: asset.exchange,
              allowedExchanges,
            });
            return false;
          }
        }
      }

      const notional = Math.round(positionSize * 100) / 100;
      const suffix = idempotencySuffix ?? String(Math.floor(Date.now() / 300_000));
      const idempotency_key = `harness:buy:${orderSymbol}:${suffix}`;
      const execution = await this.executionService.submitOrder({
        broker,
        idempotency_key,
        order: {
          symbol: orderSymbol,
          asset_class: isCrypto ? "crypto" : "us_equity",
          side: "buy",
          notional,
          order_type: "market",
          time_in_force: timeInForce,
        },
      });

      this.log("Executor", "buy_executed", {
        symbol: orderSymbol,
        isCrypto,
        size: positionSize,
        size_pct: Number(sizePct.toFixed(2)),
        confidence: Number(confidence.toFixed(3)),
        symbol_volatility_pct: Number((symbolVolatility * 100).toFixed(2)),
        dynamic_risk_multiplier: riskProfile.multiplier,
        regime: riskProfile.marketRegime,
        submission_state: execution.submission.state,
        broker_order_id: execution.broker_order_id ?? null,
      });
      this.rememberEpisode(
        `Buy executed for ${orderSymbol} ($${positionSize.toFixed(2)})`,
        "success",
        ["trade", "buy", orderSymbol, riskProfile.marketRegime],
        {
          impact: Math.min(1, positionSize / Math.max(1, this.state.config.max_position_value)),
          confidence,
          novelty: 0.45,
          metadata: {
            sizePct,
            riskMultiplier: riskProfile.multiplier,
            regime: riskProfile.marketRegime,
          },
        }
      );
      return execution.accepted;
    } catch (error) {
      this.log("Executor", "buy_failed", { symbol, error: String(error) });
      this.rememberEpisode(`Buy failed for ${symbol}`, "failure", ["trade", "buy", symbol, "error"], {
        impact: 0.4,
        confidence,
        novelty: 0.5,
        metadata: { error: String(error) },
      });
      return false;
    }
  }

  private async executeSell(
    broker: BrokerProviders,
    symbol: string,
    reason: string,
    idempotencySuffix?: string
  ): Promise<boolean> {
    if (!symbol || symbol.trim().length === 0) {
      this.log("Executor", "sell_blocked", { reason: "INVARIANT: Empty symbol" });
      return false;
    }

    if (!reason || reason.trim().length === 0) {
      this.log("Executor", "sell_blocked", { symbol, reason: "INVARIANT: No sell reason provided" });
      return false;
    }

    try {
      const pos = await broker.trading.getPosition(symbol);
      if (!pos) {
        this.log("Executor", "sell_skipped", { symbol, reason: "Position not found" });
        return false;
      }

      const isCrypto = isCryptoSymbol(pos.symbol, this.state.config.crypto_symbols || []) || pos.symbol.includes("/");
      const timeInForce = isCrypto ? "gtc" : "day";

      const entry = this.state.positionEntries[pos.symbol];
      const suffix = idempotencySuffix ?? String(entry?.entry_time ?? Math.floor(Date.now() / 300_000));
      const idempotency_key = `harness:sell:${pos.symbol}:${suffix}`;

      const execution = await this.executionService.submitOrder({
        broker,
        idempotency_key,
        order: {
          symbol: pos.symbol,
          asset_class: isCrypto ? "crypto" : "us_equity",
          side: "sell",
          qty: pos.qty,
          order_type: "market",
          time_in_force: timeInForce,
        },
      });

      this.log("Executor", "sell_executed", {
        symbol: pos.symbol,
        reason,
        submission_state: execution.submission.state,
        broker_order_id: execution.broker_order_id ?? null,
      });

      if (execution.submission.state === "SUBMITTED") {
        const returnPct = pos.market_value > 0 ? (pos.unrealized_pl / pos.market_value) * 100 : 0;
        const entry = this.state.positionEntries[pos.symbol];
        this.updatePredictiveModelFromTrade(pos.symbol, returnPct, entry);

        delete this.state.positionEntries[pos.symbol];
        delete this.state.socialHistory[pos.symbol];
        delete this.state.stalenessAnalysis[pos.symbol];

        this.rememberEpisode(
          `Sell executed for ${pos.symbol}: ${reason}`,
          pos.unrealized_pl >= 0 ? "success" : "failure",
          ["trade", "sell", pos.symbol],
          {
            impact: Math.min(1, Math.abs(pos.unrealized_pl) / Math.max(1, pos.market_value || 1)),
            confidence: 0.75,
            novelty: 0.35,
            metadata: {
              unrealized_pl: pos.unrealized_pl,
              reason,
            },
          }
        );

        if (this.env.RISK_MANAGER) {
          const realizedPnl = pos.unrealized_pl ?? 0;
          const id = this.env.RISK_MANAGER.idFromName("default");
          const stub = this.env.RISK_MANAGER.get(id);
          stub
            .fetch("http://risk/update-loss", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ profitLoss: realizedPnl }),
            })
            .catch((e) => {
              this.log("Executor", "risk_pnl_report_failed", { symbol: pos.symbol, error: String(e) });
            });
        }
      }

      return execution.accepted;
    } catch (error) {
      this.log("Executor", "sell_failed", { symbol, error: String(error) });
      this.rememberEpisode(`Sell failed for ${symbol}`, "failure", ["trade", "sell", symbol, "error"], {
        impact: 0.3,
        confidence: 0.65,
        novelty: 0.4,
        metadata: { error: String(error), reason },
      });
      return false;
    }
  }

  // ============================================================================
  // SECTION 8: STALENESS DETECTION
  // ============================================================================
  // [TOGGLE] Enable with stale_position_enabled in config
  // [TUNE] Staleness thresholds (hold time, volume decay, gain requirements)
  //
  // Staleness = positions that lost momentum. Scored 0-100 based on:
  // - Time held (vs max hold days)
  // - Price action (P&L vs targets)
  // - Social volume decay (vs entry volume)
  // ============================================================================

  private analyzeStaleness(
    symbol: string,
    currentPrice: number,
    currentSocialVolume: number
  ): {
    isStale: boolean;
    reason: string;
    staleness_score: number;
  } {
    const entry = this.state.positionEntries[symbol];
    if (!entry) {
      return { isStale: false, reason: "No entry data", staleness_score: 0 };
    }

    const holdHours = (Date.now() - entry.entry_time) / (1000 * 60 * 60);
    const holdDays = holdHours / 24;
    const pnlPct = entry.entry_price > 0 ? ((currentPrice - entry.entry_price) / entry.entry_price) * 100 : 0;

    if (holdHours < this.state.config.stale_min_hold_hours) {
      return { isStale: false, reason: `Too early (${holdHours.toFixed(1)}h)`, staleness_score: 0 };
    }

    let stalenessScore = 0;

    // Time-based (max 40 points)
    if (holdDays >= this.state.config.stale_max_hold_days) {
      stalenessScore += 40;
    } else if (holdDays >= this.state.config.stale_mid_hold_days) {
      stalenessScore +=
        (20 * (holdDays - this.state.config.stale_mid_hold_days)) /
        (this.state.config.stale_max_hold_days - this.state.config.stale_mid_hold_days);
    }

    // Price action (max 30 points)
    if (pnlPct < 0) {
      stalenessScore += Math.min(30, Math.abs(pnlPct) * 3);
    } else if (pnlPct < this.state.config.stale_mid_min_gain_pct && holdDays >= this.state.config.stale_mid_hold_days) {
      stalenessScore += 15;
    }

    // Social volume decay (max 30 points)
    const volumeRatio = entry.entry_social_volume > 0 ? currentSocialVolume / entry.entry_social_volume : 1;
    if (volumeRatio <= this.state.config.stale_social_volume_decay) {
      stalenessScore += 30;
    } else if (volumeRatio <= 0.5) {
      stalenessScore += 15;
    }

    stalenessScore = Math.min(100, stalenessScore);

    const isStale =
      stalenessScore >= 70 ||
      (holdDays >= this.state.config.stale_max_hold_days && pnlPct < this.state.config.stale_min_gain_pct);

    return {
      isStale,
      reason: isStale
        ? `Staleness score ${stalenessScore}/100, held ${holdDays.toFixed(1)} days`
        : `OK (score ${stalenessScore}/100)`,
      staleness_score: stalenessScore,
    };
  }

  // ============================================================================
  // SECTION 9: OPTIONS TRADING
  // ============================================================================
  // [TOGGLE] Enable with options_enabled in config
  // [TUNE] Delta, DTE, and position size limits in config
  //
  // Options are used for HIGH CONVICTION plays only (confidence >= 0.8).
  // Finds ATM/ITM calls for bullish signals, puts for bearish.
  // Wider stop-loss (50%) and higher take-profit (100%) than stocks.
  // ============================================================================

  private isOptionsEnabled(): boolean {
    if (this.state.config.options_enabled !== true) return false;
    const broker = createBrokerProviders(this.env, this.state.config.broker);
    return broker.options.isConfigured();
  }

  private async findBestOptionsContract(
    symbol: string,
    direction: "bullish" | "bearish",
    equity: number
  ): Promise<{
    symbol: string;
    strike: number;
    expiration: string;
    delta: number;
    mid_price: number;
    max_contracts: number;
  } | null> {
    if (!this.isOptionsEnabled()) return null;

    try {
      const broker = createBrokerProviders(this.env, this.state.config.broker);
      const expirations = await broker.options.getExpirations(symbol);

      if (!expirations || expirations.length === 0) {
        this.log("Options", "no_expirations", { symbol });
        return null;
      }

      const today = new Date();
      const validExpirations = expirations.filter((exp) => {
        const expDate = new Date(exp);
        const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        return dte >= this.state.config.options_min_dte && dte <= this.state.config.options_max_dte;
      });

      if (validExpirations.length === 0) {
        this.log("Options", "no_valid_expirations", { symbol });
        return null;
      }

      const targetDTE = (this.state.config.options_min_dte + this.state.config.options_max_dte) / 2;
      const bestExpiration = validExpirations.reduce((best: string, exp: string) => {
        const expDate = new Date(exp);
        const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const currentBestDte = Math.ceil((new Date(best).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        return Math.abs(dte - targetDTE) < Math.abs(currentBestDte - targetDTE) ? exp : best;
      }, validExpirations[0]!);

      const chain = await broker.options.getChain(symbol, bestExpiration);
      if (!chain) {
        this.log("Options", "chain_failed", { symbol, expiration: bestExpiration });
        return null;
      }

      const contracts = direction === "bullish" ? chain.calls : chain.puts;
      if (!contracts || contracts.length === 0) {
        this.log("Options", "no_contracts", { symbol, direction });
        return null;
      }

      const snapshot = await broker.marketData.getSnapshot(symbol).catch(() => null);
      const stockPrice =
        snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || snapshot?.latest_quote?.bid_price || 0;
      if (stockPrice === 0) return null;

      const targetStrike =
        direction === "bullish"
          ? stockPrice * (1 - (this.state.config.options_target_delta - 0.5) * 0.2)
          : stockPrice * (1 + (this.state.config.options_target_delta - 0.5) * 0.2);

      const sortedContracts = contracts
        .filter((c) => c.strike > 0)
        .sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));

      for (const contract of sortedContracts.slice(0, 5)) {
        const snapshot = await broker.options.getSnapshot(contract.symbol);
        if (!snapshot) continue;

        const delta = snapshot.greeks?.delta;
        const absDelta = delta !== undefined ? Math.abs(delta) : null;

        if (
          absDelta === null ||
          absDelta < this.state.config.options_min_delta ||
          absDelta > this.state.config.options_max_delta
        ) {
          continue;
        }

        const bid = snapshot.latest_quote?.bid_price || 0;
        const ask = snapshot.latest_quote?.ask_price || 0;
        if (bid === 0 || ask === 0) continue;

        const spread = (ask - bid) / ask;
        if (spread > 0.1) continue;

        const midPrice = (bid + ask) / 2;
        const maxCost = equity * this.state.config.options_max_pct_per_trade;
        const maxContracts = Math.floor(maxCost / (midPrice * 100));

        if (maxContracts < 1) continue;

        this.log("Options", "contract_selected", {
          symbol,
          contract: contract.symbol,
          strike: contract.strike,
          expiration: bestExpiration,
          delta: delta?.toFixed(3),
          mid_price: midPrice.toFixed(2),
        });

        return {
          symbol: contract.symbol,
          strike: contract.strike,
          expiration: bestExpiration,
          delta: delta!,
          mid_price: midPrice,
          max_contracts: maxContracts,
        };
      }

      return null;
    } catch (error) {
      this.log("Options", "error", { symbol, message: String(error) });
      return null;
    }
  }

  private async executeOptionsOrder(
    contract: { symbol: string; mid_price: number },
    quantity: number,
    equity: number
  ): Promise<boolean> {
    if (!this.isOptionsEnabled()) return false;

    const totalCost = contract.mid_price * quantity * 100;
    const maxAllowed = equity * this.state.config.options_max_pct_per_trade;

    if (totalCost > maxAllowed) {
      quantity = Math.floor(maxAllowed / (contract.mid_price * 100));
      if (quantity < 1) {
        this.log("Options", "skipped_size", { contract: contract.symbol, cost: totalCost, max: maxAllowed });
        return false;
      }
    }

    try {
      const broker = createBrokerProviders(this.env, this.state.config.broker);
      const order = await broker.trading.createOrder({
        symbol: contract.symbol,
        qty: quantity,
        side: "buy",
        type: "limit",
        limit_price: Math.round(contract.mid_price * 100) / 100,
        time_in_force: "day",
      });

      this.log("Options", "options_buy_executed", {
        contract: contract.symbol,
        qty: quantity,
        status: order.status,
        estimated_cost: (contract.mid_price * quantity * 100).toFixed(2),
      });

      return true;
    } catch (error) {
      this.log("Options", "options_buy_failed", { contract: contract.symbol, error: String(error) });
      return false;
    }
  }

  private async checkOptionsExits(positions: Position[]): Promise<
    Array<{
      symbol: string;
      reason: string;
      type: string;
      pnl_pct: number;
    }>
  > {
    if (!this.isOptionsEnabled()) return [];

    const exits: Array<{ symbol: string; reason: string; type: string; pnl_pct: number }> = [];
    const optionsPositions = positions.filter((p) => p.asset_class === "us_option");

    for (const pos of optionsPositions) {
      const entryPrice = pos.avg_entry_price || pos.current_price;
      const plPct = entryPrice > 0 ? ((pos.current_price - entryPrice) / entryPrice) * 100 : 0;

      if (plPct <= -this.state.config.options_stop_loss_pct) {
        exits.push({
          symbol: pos.symbol,
          reason: `Options stop loss at ${plPct.toFixed(1)}%`,
          type: "stop_loss",
          pnl_pct: plPct,
        });
        continue;
      }

      if (plPct >= this.state.config.options_take_profit_pct) {
        exits.push({
          symbol: pos.symbol,
          reason: `Options take profit at +${plPct.toFixed(1)}%`,
          type: "take_profit",
          pnl_pct: plPct,
        });
      }
    }

    return exits;
  }

  // ============================================================================
  // SECTION 10: PRE-MARKET ANALYSIS
  // ============================================================================
  // Runs 9:25-9:29 AM ET to prepare a trading plan before market open.
  // Executes the plan at 9:30-9:32 AM when market opens.
  //
  // [TUNE] Change time windows in isPreMarketWindow() / isMarketJustOpened()
  // [TUNE] Plan staleness (PLAN_STALE_MS) in executePremarketPlan()
  // ============================================================================

  private nyTimeParts(clockTimestamp: string): { weekday: number; hour: number; minute: number } | null {
    const date = new Date(clockTimestamp);
    if (!Number.isFinite(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const weekdayText = parts.find((p) => p.type === "weekday")?.value;
    const hourText = parts.find((p) => p.type === "hour")?.value;
    const minuteText = parts.find((p) => p.type === "minute")?.value;

    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayText ? weekdayMap[weekdayText] : undefined;
    const hour = hourText ? Number.parseInt(hourText, 10) : NaN;
    const minute = minuteText ? Number.parseInt(minuteText, 10) : NaN;

    if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { weekday, hour, minute };
  }

  private isPreMarketWindow(broker: string, clock: MarketClock): boolean {
    if (broker !== "alpaca") return false;
    const parts = this.nyTimeParts(clock.timestamp);
    if (!parts) return false;
    if (parts.weekday < 1 || parts.weekday > 5) return false;
    return parts.hour === 9 && parts.minute >= 25 && parts.minute <= 29;
  }

  private isMarketJustOpened(broker: string, clock: MarketClock): boolean {
    if (broker !== "alpaca") return false;
    const parts = this.nyTimeParts(clock.timestamp);
    if (!parts) return false;
    if (parts.weekday < 1 || parts.weekday > 5) return false;
    return parts.hour === 9 && parts.minute >= 30 && parts.minute <= 32;
  }

  private async runPreMarketAnalysis(): Promise<void> {
    const broker = createBrokerProviders(this.env, this.state.config.broker);
    if (broker.broker !== "alpaca") return;
    const [account, positions] = await Promise.all([broker.trading.getAccount(), broker.trading.getPositions()]);

    if (!account || this.state.signalCache.length === 0) return;

    this.log("System", "premarket_analysis_starting", {
      signals: this.state.signalCache.length,
      researched: Object.keys(this.state.signalResearch).length,
    });

    const signalResearch = await this.researchService.researchTopSignals(10);
    const analysis = await this.analyzeSignalsWithLLM(this.state.signalCache, positions, account);

    this.state.premarketPlan = {
      timestamp: Date.now(),
      recommendations: analysis.recommendations.map((r) => ({
        action: r.action,
        symbol: r.symbol,
        confidence: r.confidence,
        reasoning: r.reasoning,
        suggested_size_pct: r.suggested_size_pct,
      })),
      market_summary: analysis.market_summary,
      high_conviction: analysis.high_conviction,
      researched_buys: signalResearch.filter((r) => r.verdict === "BUY"),
    };

    const buyRecs = this.state.premarketPlan.recommendations.filter((r) => r.action === "BUY").length;
    const sellRecs = this.state.premarketPlan.recommendations.filter((r) => r.action === "SELL").length;

    this.log("System", "premarket_analysis_complete", {
      buy_recommendations: buyRecs,
      sell_recommendations: sellRecs,
      high_conviction: this.state.premarketPlan.high_conviction,
    });
  }

  private async executePremarketPlan(): Promise<void> {
    const PLAN_STALE_MS = 600_000;

    if (!this.state.premarketPlan || Date.now() - this.state.premarketPlan.timestamp > PLAN_STALE_MS) {
      this.log("System", "no_premarket_plan", { reason: "Plan missing or stale" });
      return;
    }

    const broker = createBrokerProviders(this.env, this.state.config.broker);
    if (broker.broker !== "alpaca") return;
    const [account, positions] = await Promise.all([broker.trading.getAccount(), broker.trading.getPositions()]);

    if (!account) return;

    const heldSymbols = new Set(positions.map((p) => p.symbol));

    this.log("System", "executing_premarket_plan", {
      recommendations: this.state.premarketPlan.recommendations.length,
    });

    const idempotencySuffix = `premarket:${this.state.premarketPlan.timestamp}`;

    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "SELL" && rec.confidence >= this.state.config.min_analyst_confidence) {
        await this.executeSell(broker, rec.symbol, `Pre-market plan: ${rec.reasoning}`, idempotencySuffix);
      }
    }

    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "BUY" && rec.confidence >= this.state.config.min_analyst_confidence) {
        if (heldSymbols.has(rec.symbol)) continue;
        if (positions.length >= this.state.config.max_positions) break;
        const adjustedConfidence = this.applyRegimeConfidenceAdjustment(rec.confidence, rec.confidence);
        if (!this.state.lastStressTest?.passed && adjustedConfidence < 0.9) continue;

        const result = await this.executeBuy(broker, rec.symbol, adjustedConfidence, account, idempotencySuffix);
        if (result) {
          heldSymbols.add(rec.symbol);

          const originalSignal = this.state.signalCache.find((s) => s.symbol === rec.symbol);
          const predicted = this.predictSignalProbability({
            symbol: rec.symbol,
            sentiment: originalSignal?.sentiment ?? rec.confidence,
            freshness: originalSignal?.freshness ?? 0.5,
            volume: originalSignal?.volume ?? 1,
            sourceDiversity: new Set(this.state.signalCache.filter((s) => s.symbol === rec.symbol).map((s) => s.source))
              .size,
          });
          this.state.positionEntries[rec.symbol] = {
            symbol: rec.symbol,
            entry_time: Date.now(),
            entry_price: 0,
            entry_sentiment: originalSignal?.sentiment || 0,
            entry_social_volume: originalSignal?.volume || 0,
            entry_sources: originalSignal?.subreddits || [originalSignal?.source || "premarket"],
            entry_reason: rec.reasoning,
            peak_price: 0,
            peak_sentiment: originalSignal?.sentiment || 0,
            entry_prediction: predicted,
            entry_regime: this.state.marketRegime.type,
          };
        }
      }
    }

    this.state.premarketPlan = null;
  }

  // ============================================================================
  // SECTION 11: UTILITIES
  // ============================================================================
  // Logging, cost tracking, persistence, and Discord notifications.
  // Generally don't need to modify unless adding new notification channels.
  // ============================================================================

  private normalizeLogSeverity(value: unknown): ActivitySeverity | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "debug" ||
      normalized === "info" ||
      normalized === "warning" ||
      normalized === "error" ||
      normalized === "critical"
    ) {
      return normalized;
    }
    return null;
  }

  private normalizeLogStatus(value: unknown): ActivityStatus | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "info" ||
      normalized === "started" ||
      normalized === "in_progress" ||
      normalized === "success" ||
      normalized === "warning" ||
      normalized === "failed" ||
      normalized === "skipped"
    ) {
      return normalized;
    }
    return null;
  }

  private normalizeEventType(value: unknown): ActivityEventType | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "agent" ||
      normalized === "trade" ||
      normalized === "crypto" ||
      normalized === "research" ||
      normalized === "system" ||
      normalized === "swarm" ||
      normalized === "risk" ||
      normalized === "data" ||
      normalized === "api"
    ) {
      return normalized;
    }
    return null;
  }

  private humanizeAction(action: string): string {
    return action
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private sanitizeLogValue(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length <= 800) return trimmed;
      return `${trimmed.slice(0, 800)}... [truncated ${trimmed.length - 800} chars]`;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (depth >= 2) {
      try {
        const serialized = JSON.stringify(value);
        return serialized.length <= 800
          ? JSON.parse(serialized)
          : `${serialized.slice(0, 800)}... [truncated ${serialized.length - 800} chars]`;
      } catch {
        return String(value);
      }
    }
    if (Array.isArray(value)) {
      const maxItems = 20;
      const next = value.slice(0, maxItems).map((item) => this.sanitizeLogValue(item, depth + 1));
      if (value.length > maxItems) {
        next.push(`[+${value.length - maxItems} more items]`);
      }
      return next;
    }
    if (this.isRecord(value)) {
      const entries = Object.entries(value);
      const maxKeys = 30;
      const next: Record<string, unknown> = {};
      for (const [key, item] of entries.slice(0, maxKeys)) {
        next[key] = this.sanitizeLogValue(item, depth + 1);
      }
      if (entries.length > maxKeys) {
        next._truncated_keys = entries.length - maxKeys;
      }
      return next;
    }
    return String(value);
  }

  private sanitizeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      sanitized[key] = this.sanitizeLogValue(value);
    }
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(sanitized)).length;
      if (bytes <= 6_000) return sanitized;
      return {
        _truncated: true,
        _metadata_bytes: bytes,
        preview: JSON.stringify(sanitized).slice(0, 1_200),
      };
    } catch {
      return { _truncated: true, _metadata_error: "metadata serialization failed" };
    }
  }

  private getLogSummaryFields(metadata: Record<string, unknown>): Record<string, unknown> {
    const keys = [
      "symbol",
      "source",
      "reason",
      "message",
      "error",
      "count",
      "confidence",
      "verdict",
      "recommendation",
      "quality",
      "broker",
    ];
    const summary: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in metadata) {
        summary[key] = metadata[key];
      }
    }
    return summary;
  }

  private classifyEventType(agent: string, action: string, details: Record<string, unknown>): ActivityEventType {
    const actionKey = action.toLowerCase();
    const agentKey = agent.toLowerCase();
    const symbol = typeof details.symbol === "string" ? details.symbol : "";

    if (
      actionKey.includes("research") ||
      actionKey.includes("catalyst") ||
      actionKey.includes("verification") ||
      agentKey.includes("research") ||
      agentKey === "analyst"
    ) {
      return "research";
    }

    if (
      agentKey === "crypto" ||
      actionKey.includes("crypto") ||
      actionKey.includes("wallet") ||
      actionKey.includes("price_monitor") ||
      actionKey.includes("market_data") ||
      (symbol.length > 0 && isCryptoSymbol(symbol, this.state.config.crypto_symbols || []))
    ) {
      return "crypto";
    }

    if (
      actionKey.includes("buy") ||
      actionKey.includes("sell") ||
      actionKey.includes("order") ||
      actionKey.includes("position") ||
      actionKey.includes("execution") ||
      agentKey === "executor" ||
      agentKey === "trader" ||
      agentKey === "options"
    ) {
      return "trade";
    }

    if (
      actionKey.includes("swarm") ||
      actionKey.includes("registry") ||
      actionKey.includes("heartbeat") ||
      agentKey.includes("swarm")
    ) {
      return "swarm";
    }

    if (
      actionKey.includes("risk") ||
      actionKey.includes("stress") ||
      actionKey.includes("kill_switch") ||
      agentKey.includes("risk")
    ) {
      return "risk";
    }

    if (
      actionKey.includes("gather") ||
      actionKey.includes("signals") ||
      actionKey.includes("source_") ||
      agentKey === "stocktwits" ||
      agentKey === "reddit" ||
      agentKey === "sec" ||
      agentKey === "x" ||
      agentKey === "scout"
    ) {
      return "data";
    }

    if (
      actionKey.includes("api") ||
      actionKey.includes("auth") ||
      actionKey.includes("config") ||
      actionKey.includes("setup") ||
      actionKey.includes("history")
    ) {
      return "api";
    }

    if (agentKey === "system") {
      return "system";
    }

    return "agent";
  }

  private classifyLogSeverity(action: string, details: Record<string, unknown>): ActivitySeverity {
    const explicit = this.normalizeLogSeverity(details.severity);
    if (explicit) return explicit;

    const actionKey = action.toLowerCase();
    const errorText = typeof details.error === "string" ? details.error.toLowerCase() : "";
    const messageText = typeof details.message === "string" ? details.message.toLowerCase() : "";
    if (actionKey.includes("kill_switch") || errorText.includes("panic") || messageText.includes("panic"))
      return "critical";
    if (actionKey.includes("error") || actionKey.includes("failed") || errorText.length > 0) return "error";
    if (
      actionKey.includes("warning") ||
      actionKey.includes("skipped") ||
      actionKey.includes("deferred") ||
      actionKey.includes("blocked")
    ) {
      return "warning";
    }
    if (actionKey.includes("debug")) return "debug";
    return "info";
  }

  private classifyLogStatus(action: string, details: Record<string, unknown>): ActivityStatus {
    const explicit = this.normalizeLogStatus(details.status);
    if (explicit) return explicit;

    const actionKey = action.toLowerCase();
    if (actionKey.includes("starting") || actionKey.endsWith("_start") || actionKey.includes("_start_"))
      return "started";
    if (actionKey.includes("running") || actionKey.includes("processing") || actionKey.includes("dispatching"))
      return "in_progress";
    if (actionKey.includes("failed") || actionKey.includes("error")) return "failed";
    if (actionKey.includes("warning")) return "warning";
    if (actionKey.includes("skipped") || actionKey.includes("blocked") || actionKey.includes("deferred"))
      return "skipped";
    if (
      actionKey.includes("complete") ||
      actionKey.includes("success") ||
      actionKey.includes("executed") ||
      actionKey.includes("enabled") ||
      actionKey.includes("disabled") ||
      actionKey.includes("updated")
    ) {
      return "success";
    }
    return "info";
  }

  private summarizeLogDetails(action: string, details: Record<string, unknown>): string {
    const directDescription = typeof details.description === "string" ? details.description.trim() : "";
    if (directDescription.length > 0) return directDescription;

    const reason =
      typeof details.reason === "string"
        ? details.reason.trim()
        : typeof details.message === "string"
          ? details.message.trim()
          : typeof details.error === "string"
            ? details.error.trim()
            : "";
    if (reason.length > 0) return reason;

    const symbol = typeof details.symbol === "string" ? details.symbol.trim() : "";
    const count = typeof details.count === "number" && Number.isFinite(details.count) ? details.count : null;
    const source = typeof details.source === "string" ? details.source.trim() : "";

    const fragments: string[] = [];
    if (symbol) fragments.push(symbol);
    if (source) fragments.push(`source ${source}`);
    if (count !== null) fragments.push(`count ${count}`);

    if (fragments.length > 0) {
      return `${this.humanizeAction(action)} (${fragments.join(", ")})`;
    }

    return this.humanizeAction(action);
  }

  private buildLogEntry(agent: string, action: string, details: Record<string, unknown>): LogEntry {
    const nowMs = Date.now();
    const timestamp = new Date(nowMs).toISOString();
    const metadata = this.sanitizeLogDetails(details);
    const summary = this.getLogSummaryFields(metadata);
    const eventType = this.normalizeEventType(metadata.event_type) ?? this.classifyEventType(agent, action, metadata);
    const severity = this.classifyLogSeverity(action, metadata);
    const status = this.classifyLogStatus(action, metadata);

    return {
      id:
        typeof details.id === "string" && details.id
          ? details.id
          : `${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      timestamp_ms: nowMs,
      agent,
      action,
      ...summary,
      event_type: eventType,
      severity,
      status,
      description: this.summarizeLogDetails(action, metadata),
      metadata,
    };
  }

  private normalizeLogEntry(rawEntry: LogEntry, index: number): LogEntry | null {
    const raw = this.isRecord(rawEntry) ? rawEntry : null;
    if (!raw) return null;

    const agent = typeof raw.agent === "string" && raw.agent.trim().length > 0 ? raw.agent : "System";
    const action = typeof raw.action === "string" && raw.action.trim().length > 0 ? raw.action : "event";
    const timestampValue = typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString();
    const parsedMs = Date.parse(timestampValue);
    const timestampMs =
      typeof raw.timestamp_ms === "number" && Number.isFinite(raw.timestamp_ms) ? raw.timestamp_ms : parsedMs;
    const metadataFromRaw = this.isRecord(raw.metadata) ? raw.metadata : {};
    const metadata: Record<string, unknown> = { ...metadataFromRaw };

    for (const [key, value] of Object.entries(raw)) {
      if (
        key === "id" ||
        key === "timestamp" ||
        key === "timestamp_ms" ||
        key === "agent" ||
        key === "action" ||
        key === "event_type" ||
        key === "severity" ||
        key === "status" ||
        key === "description" ||
        key === "metadata"
      ) {
        continue;
      }
      metadata[key] = value;
    }

    const sanitizedMetadata = this.sanitizeLogDetails(metadata);
    const summary = this.getLogSummaryFields(sanitizedMetadata);
    const eventType =
      this.normalizeEventType(raw.event_type) ?? this.classifyEventType(agent, action, sanitizedMetadata);
    const severity = this.normalizeLogSeverity(raw.severity) ?? this.classifyLogSeverity(action, sanitizedMetadata);
    const status = this.normalizeLogStatus(raw.status) ?? this.classifyLogStatus(action, sanitizedMetadata);
    const description =
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description.trim()
        : this.summarizeLogDetails(action, sanitizedMetadata);
    const nowMs = Date.now();
    const safeTimestampMs = Number.isFinite(timestampMs) ? timestampMs : nowMs;

    return {
      id:
        typeof raw.id === "string" && raw.id.trim().length > 0
          ? raw.id
          : `legacy-${safeTimestampMs.toString(36)}-${index}`,
      timestamp: Number.isFinite(parsedMs) ? timestampValue : new Date(safeTimestampMs).toISOString(),
      timestamp_ms: safeTimestampMs,
      agent,
      action,
      event_type: eventType,
      severity,
      status,
      description,
      metadata: sanitizedMetadata,
      ...summary,
    };
  }

  private queueLogPersistence(force = false): void {
    const now = Date.now();
    if (force || now - this.lastLogPersistAt >= LOG_FLUSH_INTERVAL_MS) {
      this.lastLogPersistAt = now;
      this.ctx.waitUntil(
        this.persist().catch((error) => {
          console.error("[OwokxHarness] log_persist_failed", String(error));
        })
      );
      return;
    }

    if (this.logPersistTimerArmed) return;
    this.logPersistTimerArmed = true;
    const waitMs = Math.max(0, LOG_FLUSH_INTERVAL_MS - (now - this.lastLogPersistAt));
    this.ctx.waitUntil(
      this.sleep(waitMs)
        .then(async () => {
          this.lastLogPersistAt = Date.now();
          await this.persist();
        })
        .catch((error) => {
          console.error("[OwokxHarness] deferred_log_persist_failed", String(error));
        })
        .finally(() => {
          this.logPersistTimerArmed = false;
        })
    );
  }

  private log(agent: string, action: string, details: Record<string, unknown>): void {
    const entry = this.buildLogEntry(agent, action, details);
    this.state.logs.push(entry);

    if (this.state.logs.length > LOG_RETENTION_MAX) {
      this.state.logs = this.state.logs.slice(-LOG_RETENTION_MAX);
    }

    const mustFlush = entry.severity === "error" || entry.severity === "critical" || entry.status === "failed";
    this.queueLogPersistence(mustFlush);

    // Log NDJSON for wrangler tail / file redirection
    console.log(JSON.stringify(entry));
  }

  public trackLLMCost(model: string, tokensIn: number, tokensOut: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
      "gpt-4o": { input: 2.5, output: 10 },
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
      "deepseek-chat": { input: 0.27, output: 1.1 },
      "deepseek-reasoner": { input: 0.55, output: 2.19 },
    };

    const safeTokensIn = Number.isFinite(tokensIn) ? Math.max(0, tokensIn) : 0;
    const safeTokensOut = Number.isFinite(tokensOut) ? Math.max(0, tokensOut) : 0;
    const normalizedModel = model.includes("/") ? (model.split("/", 2)[1] ?? model) : model;
    const rates = pricing[normalizedModel] ?? pricing[model] ?? pricing["gpt-4o-mini"]!;
    const cost = (safeTokensIn * rates.input + safeTokensOut * rates.output) / 1_000_000;

    this.state.costTracker.total_usd += cost;
    this.state.costTracker.calls++;
    this.state.costTracker.tokens_in += safeTokensIn;
    this.state.costTracker.tokens_out += safeTokensOut;
    this.telemetry.increment("llm_calls_total", 1, { model: normalizedModel });
    this.telemetry.increment("llm_tokens_in_total", safeTokensIn, { model: normalizedModel });
    this.telemetry.increment("llm_tokens_out_total", safeTokensOut, { model: normalizedModel });
    this.telemetry.increment("llm_cost_usd_total", cost, { model: normalizedModel });

    return cost;
  }

  private withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
        reject(new Error(`${label} exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      operation
        .then((value) => {
          clearTimeout(timeoutHandle);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }

  private isSqliteTooBigError(error: unknown): boolean {
    const message = String(error).toUpperCase();
    return message.includes("SQLITE_TOOBIG") || message.includes("STRING OR BLOB TOO BIG");
  }

  private capRecordByTimestamp<T extends { timestamp?: number }>(
    record: Record<string, T>,
    maxEntries: number
  ): Record<string, T> {
    const entries = Object.entries(record);
    if (entries.length <= maxEntries) return record;
    return Object.fromEntries(
      entries.sort((a, b) => (b[1]?.timestamp ?? 0) - (a[1]?.timestamp ?? 0)).slice(0, maxEntries)
    );
  }

  private applyStatePersistenceTrim(
    maxLogs: number,
    maxMemoryEpisodes: number,
    maxPortfolioPoints: number,
    maxSignalCache: number
  ): void {
    if (this.state.logs.length > maxLogs) {
      this.state.logs = this.state.logs.slice(-maxLogs);
    }
    if (this.state.memoryEpisodes.length > maxMemoryEpisodes) {
      this.state.memoryEpisodes = this.state.memoryEpisodes.slice(-maxMemoryEpisodes);
    }
    if (this.state.portfolioEquityHistory.length > maxPortfolioPoints) {
      this.state.portfolioEquityHistory = this.state.portfolioEquityHistory.slice(-maxPortfolioPoints);
    }
    if (this.state.signalCache.length > maxSignalCache) {
      this.state.signalCache = [...this.state.signalCache]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, maxSignalCache);
      this.state.signalCacheBytesEstimate = this.estimateObjectSizeBytes(this.state.signalCache);
    }

    this.state.signalResearch = this.capRecordByTimestamp(this.state.signalResearch, 300);
    this.state.positionResearch = this.capRecordByTimestamp(
      this.state.positionResearch as Record<string, { timestamp?: number }>,
      250
    ) as Record<string, unknown>;
    this.state.twitterConfirmations = this.capRecordByTimestamp(this.state.twitterConfirmations, 200);
    this.state.stalenessAnalysis = this.capRecordByTimestamp(
      this.state.stalenessAnalysis as Record<string, { timestamp?: number }>,
      250
    ) as Record<string, unknown>;
  }

  private async persist(): Promise<void> {
    try {
      await this.ctx.storage.put("state", this.state);
      return;
    } catch (error) {
      if (!this.isSqliteTooBigError(error)) {
        throw error;
      }
      console.error("[OwokxHarness] persist_oversize_detected", String(error));
    }

    for (let i = 0; i < PERSIST_RETRY_LOG_LIMITS.length; i++) {
      this.applyStatePersistenceTrim(
        PERSIST_RETRY_LOG_LIMITS[i]!,
        PERSIST_RETRY_MEMORY_LIMITS[i]!,
        PERSIST_RETRY_PORTFOLIO_LIMITS[i]!,
        PERSIST_RETRY_SIGNAL_CACHE_LIMITS[i]!
      );
      try {
        await this.ctx.storage.put("state", this.state);
        console.warn(
          "[OwokxHarness] persist_recovered_after_trim",
          JSON.stringify({
            logs: this.state.logs.length,
            memoryEpisodes: this.state.memoryEpisodes.length,
            portfolioPoints: this.state.portfolioEquityHistory.length,
            signalCache: this.state.signalCache.length,
            retry: i + 1,
          })
        );
        return;
      } catch (error) {
        if (!this.isSqliteTooBigError(error)) {
          throw error;
        }
      }
    }

    console.error(
      "[OwokxHarness] persist_failed_after_trim",
      JSON.stringify({
        logs: this.state.logs.length,
        memoryEpisodes: this.state.memoryEpisodes.length,
        portfolioPoints: this.state.portfolioEquityHistory.length,
        signalCache: this.state.signalCache.length,
      })
    );
  }

  private jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  get llm(): LLMProvider | null {
    return this._llm;
  }

  private discordCooldowns: Map<string, number> = new Map();
  private readonly DISCORD_COOLDOWN_MS = 30 * 60 * 1000;

  private async sendDiscordNotification(
    type: "signal" | "research",
    data: {
      symbol: string;
      sentiment?: number;
      sources?: string[];
      verdict?: string;
      confidence?: number;
      quality?: string;
      reasoning?: string;
      catalysts?: string[];
      red_flags?: string[];
    }
  ): Promise<void> {
    if (!this.env.DISCORD_WEBHOOK_URL) return;

    const cacheKey = data.symbol;
    const lastNotification = this.discordCooldowns.get(cacheKey);
    if (lastNotification && Date.now() - lastNotification < this.DISCORD_COOLDOWN_MS) {
      return;
    }

    try {
      let embed: {
        title: string;
        color: number;
        fields: Array<{ name: string; value: string; inline: boolean }>;
        description?: string;
        timestamp: string;
        footer: { text: string };
      };

      if (type === "signal") {
        embed = {
          title: `🔔 SIGNAL: $${data.symbol}`,
          color: 0xfbbf24,
          fields: [
            { name: "Sentiment", value: `${((data.sentiment || 0) * 100).toFixed(0)}% bullish`, inline: true },
            { name: "Sources", value: data.sources?.join(", ") || "StockTwits", inline: true },
          ],
          description: "High sentiment detected, researching...",
          timestamp: new Date().toISOString(),
          footer: { text: "Owokx • Not financial advice • DYOR" },
        };
      } else {
        const verdictEmoji = data.verdict === "BUY" ? "✅" : data.verdict === "SKIP" ? "⏭️" : "⏸️";
        const color = data.verdict === "BUY" ? 0x22c55e : data.verdict === "SKIP" ? 0x6b7280 : 0xfbbf24;

        embed = {
          title: `${verdictEmoji} $${data.symbol} → ${data.verdict}`,
          color,
          fields: [
            { name: "Confidence", value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
            { name: "Quality", value: data.quality || "N/A", inline: true },
            { name: "Sentiment", value: `${((data.sentiment || 0) * 100).toFixed(0)}%`, inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: "Owokx • Not financial advice • DYOR" },
        };

        if (data.reasoning) {
          embed.description = data.reasoning.substring(0, 300) + (data.reasoning.length > 300 ? "..." : "");
        }

        if (data.catalysts && data.catalysts.length > 0) {
          embed.fields.push({ name: "Catalysts", value: data.catalysts.slice(0, 3).join(", "), inline: false });
        }

        if (data.red_flags && data.red_flags.length > 0) {
          embed.fields.push({ name: "⚠️ Red Flags", value: data.red_flags.slice(0, 3).join(", "), inline: false });
        }
      }

      await fetch(this.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });

      this.discordCooldowns.set(cacheKey, Date.now());
      this.log("Discord", "notification_sent", { type, symbol: data.symbol });
    } catch (err) {
      this.log("Discord", "notification_failed", { error: String(err) });
    }
  }
}

// ============================================================================
// SECTION 12: EXPORTS & HELPERS
// ============================================================================
// Helper functions to interact with the DO from your worker.
// ============================================================================

export function getHarnessStub(env: Env): DurableObjectStub {
  if (!env.OWOKX_HARNESS) {
    throw new Error("OWOKX_HARNESS binding not configured - check wrangler.toml");
  }
  const id = env.OWOKX_HARNESS.idFromName("main");
  return env.OWOKX_HARNESS.get(id);
}

export async function getHarnessStatus(env: Env): Promise<unknown> {
  const stub = getHarnessStub(env);
  const response = await stub.fetch(new Request("http://harness/status"));
  return response.json();
}

export async function enableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/enable"));
}

export async function disableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/disable"));
}
