import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../lib/errors";

type Submission = {
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
};

const submissionsByKey = new Map<string, Submission>();
const submissionsById = new Map<string, Submission>();

let killSwitchActive = false;
let policyOverride: Record<string, unknown> | null = null;
let createdOrders: Array<{ client_order_id?: string; symbol: string }> = [];

vi.mock("../storage/d1/queries/order-submissions", () => {
  return {
    getOrderSubmissionByIdempotencyKey: vi.fn(async (_db: unknown, idempotencyKey: string) => {
      return submissionsByKey.get(idempotencyKey) ?? null;
    }),
    reserveOrderSubmission: vi.fn(
      async (
        _db: unknown,
        params: {
          idempotency_key: string;
          source: string;
          approval_id?: string | null;
          broker_provider: string;
          request_json: string;
        }
      ) => {
        const existing = submissionsByKey.get(params.idempotency_key);
        if (existing) return existing;
        const row: Submission = {
          id: `sub_${submissionsByKey.size + 1}`,
          idempotency_key: params.idempotency_key,
          source: params.source,
          approval_id: params.approval_id ?? null,
          broker_provider: params.broker_provider,
          request_json: params.request_json,
          state: "RESERVED",
          broker_order_id: null,
          last_error_json: null,
          created_at: "now",
          updated_at: "now",
        };
        submissionsByKey.set(params.idempotency_key, row);
        submissionsById.set(row.id, row);
        return row;
      }
    ),
    tryTransitionOrderSubmissionState: vi.fn(
      async (_db: unknown, id: string, fromStates: string[], toState: string) => {
        const row = submissionsById.get(id);
        if (!row) return false;
        if (!fromStates.includes(row.state)) return false;
        row.state = toState;
        return true;
      }
    ),
    setOrderSubmissionState: vi.fn(
      async (
        _db: unknown,
        id: string,
        state: string,
        extra?: { broker_order_id?: string | null; last_error_json?: string | null }
      ) => {
        const row = submissionsById.get(id);
        if (!row) throw new Error("submission not found");
        row.state = state;
        if (extra?.broker_order_id !== undefined) row.broker_order_id = extra.broker_order_id ?? null;
        if (extra?.last_error_json !== undefined) row.last_error_json = extra.last_error_json ?? null;
      }
    ),
  };
});

vi.mock("../storage/d1/queries/risk-state", () => {
  return {
    getRiskState: vi.fn(async () => {
      return {
        kill_switch_active: killSwitchActive,
        kill_switch_reason: killSwitchActive ? "halt" : null,
        kill_switch_at: null,
        daily_loss_usd: 0,
        daily_loss_reset_at: null,
        last_loss_at: null,
        cooldown_until: null,
        updated_at: "now",
      };
    }),
  };
});

vi.mock("../storage/d1/queries/policy-config", () => {
  return {
    getPolicyConfig: vi.fn(async () => policyOverride),
  };
});

vi.mock("../storage/d1/queries/trades", () => {
  return {
    createTrade: vi.fn(async () => "trade_1"),
  };
});

import { executeOrder } from "./execute-order";

function envStub() {
  return {
    DB: {} as unknown as D1Database,
    CACHE: {} as unknown as KVNamespace,
    ARTIFACTS: {} as unknown as R2Bucket,
    SESSION: {} as unknown as DurableObjectNamespace,
    ALPACA_API_KEY: "x",
    ALPACA_API_SECRET: "y",
    OWOKX_API_TOKEN: "t",
    KILL_SWITCH_SECRET: "k",
    ENVIRONMENT: "test",
    FEATURE_LLM_RESEARCH: "false",
    FEATURE_OPTIONS: "false",
    DEFAULT_MAX_POSITION_PCT: "0.1",
    DEFAULT_MAX_NOTIONAL_PER_TRADE: "5000",
    DEFAULT_MAX_DAILY_LOSS_PCT: "0.02",
    DEFAULT_COOLDOWN_MINUTES: "30",
    DEFAULT_MAX_OPEN_POSITIONS: "10",
    DEFAULT_APPROVAL_TTL_SECONDS: "300",
  };
}

function brokerStub() {
  createdOrders = [];
  return {
    broker: "alpaca",
    trading: {
      getAccount: vi.fn(async () => ({ cash: 10_000, equity: 10_000, buying_power: 10_000 }) as any),
      getPositions: vi.fn(async () => [] as any[]),
      getClock: vi.fn(async () => ({ is_open: true, timestamp: "now", next_open: "now", next_close: "later" }) as any),
      createOrder: vi.fn(async (req: any) => {
        createdOrders.push({ client_order_id: req.client_order_id, symbol: req.symbol });
        return {
          id: "ord_1",
          symbol: req.symbol,
          side: req.side,
          qty: req.qty ? String(req.qty) : null,
          type: req.type,
          status: "accepted",
          created_at: "now",
        } as any;
      }),
      getPosition: vi.fn(async () => null),
      closePosition: vi.fn(async () => ({}) as any),
      getOrder: vi.fn(async () => ({}) as any),
      listOrders: vi.fn(async () => [] as any[]),
      cancelOrder: vi.fn(async () => {}),
      cancelAllOrders: vi.fn(async () => {}),
      getCalendar: vi.fn(async () => [] as any[]),
      getAsset: vi.fn(async () => null),
      getPortfolioHistory: vi.fn(async () => ({}) as any),
    },
    marketData: {} as any,
    options: {} as any,
  };
}

beforeEach(() => {
  submissionsByKey.clear();
  submissionsById.clear();
  killSwitchActive = false;
  policyOverride = null;
  createdOrders = [];
});

describe("executeOrder", () => {
  it("is idempotent for the same idempotency_key", async () => {
    const env = envStub() as any;
    const broker = brokerStub() as any;

    const first = await executeOrder({
      env,
      db: {} as any,
      broker,
      source: "mcp",
      idempotency_key: "approval:abc",
      order: {
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        notional: 100,
        order_type: "market",
        time_in_force: "day",
      },
      approval_id: "app_1",
    });

    const second = await executeOrder({
      env,
      db: {} as any,
      broker,
      source: "mcp",
      idempotency_key: "approval:abc",
      order: {
        symbol: "AAPL",
        asset_class: "us_equity",
        side: "buy",
        notional: 100,
        order_type: "market",
        time_in_force: "day",
      },
      approval_id: "app_1",
    });

    expect(first.submission.state).toBe("SUBMITTED");
    expect(second.submission.state).toBe("SUBMITTED");
    expect(createdOrders.length).toBe(1);
  });

  it("blocks when kill switch is active", async () => {
    killSwitchActive = true;

    const env = envStub() as any;
    const broker = brokerStub() as any;

    await expect(
      executeOrder({
        env,
        db: {} as any,
        broker,
        source: "harness",
        idempotency_key: "harness:buy:AAPL:deadbeef",
        order: {
          symbol: "AAPL",
          asset_class: "us_equity",
          side: "buy",
          notional: 100,
          order_type: "market",
          time_in_force: "day",
        },
      })
    ).rejects.toMatchObject({ code: ErrorCode.KILL_SWITCH_ACTIVE });

    expect(createdOrders.length).toBe(0);
    const sub = submissionsByKey.get("harness:buy:AAPL:deadbeef");
    expect(sub?.state).toBe("FAILED");
  });

  it("blocks on policy violation", async () => {
    policyOverride = {
      max_position_pct_equity: 1,
      max_open_positions: 10,
      max_notional_per_trade: 1,
      allowed_order_types: ["market"],
      max_daily_loss_pct: 1,
      cooldown_minutes_after_loss: 0,
      allowed_symbols: null,
      deny_symbols: [],
      min_avg_volume: 0,
      min_price: 0,
      trading_hours_only: false,
      extended_hours_allowed: false,
      approval_token_ttl_seconds: 300,
      allow_short_selling: false,
      use_cash_only: true,
      options: {
        options_enabled: false,
        max_pct_per_option_trade: 0.02,
        max_total_options_exposure_pct: 0.1,
        min_dte: 30,
        max_dte: 60,
        min_delta: 0.3,
        max_delta: 0.7,
        allowed_strategies: ["long_call", "long_put"],
        no_averaging_down: true,
        max_option_positions: 3,
        min_confidence_for_options: 0.8,
      },
    };

    const env = envStub() as any;
    const broker = brokerStub() as any;

    await expect(
      executeOrder({
        env,
        db: {} as any,
        broker,
        source: "mcp",
        idempotency_key: "approval:pol",
        order: {
          symbol: "AAPL",
          asset_class: "us_equity",
          side: "buy",
          notional: 100,
          order_type: "market",
          time_in_force: "day",
        },
        approval_id: "app_2",
      })
    ).rejects.toMatchObject({ code: ErrorCode.POLICY_VIOLATION });

    expect(createdOrders.length).toBe(0);
    const sub = submissionsByKey.get("approval:pol");
    expect(sub?.state).toBe("FAILED");
  });
});
