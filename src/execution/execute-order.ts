import type { Env } from "../env.d";
import { createError, ErrorCode } from "../lib/errors";
import { sanitizeForLog, sha256Hex } from "../lib/utils";
import type { OrderPreview, PolicyResult } from "../mcp/types";
import { getDefaultPolicyConfig, type PolicyConfig } from "../policy/config";
import { PolicyEngine } from "../policy/engine";
import type { BrokerProviders } from "../providers/broker-factory";
import type { Account, MarketClock, Position } from "../providers/types";
import type { D1Client, OrderSubmissionRow } from "../storage/d1/client";
import { createDecisionTrace } from "../storage/d1/queries/decisions";
import {
  getOrderSubmissionByIdempotencyKey,
  reserveOrderSubmission,
  setOrderSubmissionState,
  tryTransitionOrderSubmissionState,
} from "../storage/d1/queries/order-submissions";
import { getPolicyConfig } from "../storage/d1/queries/policy-config";
import { getRiskState, type RiskState } from "../storage/d1/queries/risk-state";
import { createTrade } from "../storage/d1/queries/trades";

export type ExecutionSource = "mcp" | "harness";

export interface ExecuteOrderParams {
  env: Env;
  db: D1Client;
  broker: BrokerProviders;
  source: ExecutionSource;
  idempotency_key: string;
  order: OrderPreview;
  approval_id?: string | null;
}

export interface ExecuteOrderResult {
  submission: OrderSubmissionRow;
  broker_order_id?: string;
  trade_id?: string;
  broker_provider?: string;
  asset_class?: OrderPreview["asset_class"];
}

export interface EvaluateOrderPolicyParams {
  env: Env;
  db: D1Client;
  broker: BrokerProviders;
  order: OrderPreview;
  account?: Account;
  positions?: Position[];
  clock?: MarketClock;
  riskState?: RiskState;
  policyConfig?: PolicyConfig;
}

export interface EvaluateOrderPolicyResult {
  account: Account;
  positions: Position[];
  clock: MarketClock;
  riskState: RiskState;
  policyConfig: PolicyConfig;
  policyResult: PolicyResult;
}

export function isAcceptedSubmissionState(state: string): boolean {
  return state === "SUBMITTED" || state === "SUBMITTING";
}

function isMissingDecisionTraceSchemaError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("no such table") && message.includes("decision_traces");
}

async function recordDecisionTraceSafe(db: D1Client, params: Parameters<typeof createDecisionTrace>[1]): Promise<void> {
  try {
    await createDecisionTrace(db, params);
  } catch (error) {
    if (!isMissingDecisionTraceSchemaError(error)) {
      console.warn("[decision-trace] Unable to persist execute-order trace", String(error));
    }
  }
}

export async function evaluateOrderPolicy(params: EvaluateOrderPolicyParams): Promise<EvaluateOrderPolicyResult> {
  const [account, positions, clock, riskState, policyConfig] = await Promise.all([
    params.account ?? params.broker.trading.getAccount(),
    params.positions ?? params.broker.trading.getPositions(),
    params.clock ?? params.broker.trading.getClock(),
    params.riskState ?? getRiskState(params.db),
    params.policyConfig ?? (await getPolicyConfig(params.db)) ?? getDefaultPolicyConfig(params.env),
  ]);

  const policyEngine = new PolicyEngine(policyConfig);
  const policyResult = policyEngine.evaluate({
    order: params.order,
    account,
    positions,
    clock,
    riskState,
  });

  return {
    account,
    positions,
    clock,
    riskState,
    policyConfig,
    policyResult,
  };
}

export async function executeOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  const traceId = params.approval_id ?? params.idempotency_key;
  const request_json = JSON.stringify({ order: params.order, approval_id: params.approval_id ?? null });
  const submission = await reserveOrderSubmission(params.db, {
    idempotency_key: params.idempotency_key,
    source: params.source,
    approval_id: params.approval_id ?? null,
    broker_provider: params.broker.broker,
    request_json,
  });

  if (isAcceptedSubmissionState(submission.state)) {
    await recordDecisionTraceSafe(params.db, {
      trace_id: traceId,
      request_id: params.idempotency_key,
      source: "execute-order",
      stage: "idempotency_reuse",
      decision_kind: "execution",
      input: params.order,
      final_action: "reuse_existing_submission",
      status: "success",
      symbol: params.order.symbol,
      metadata: {
        approval_id: params.approval_id ?? null,
        source: params.source,
        submission_id: submission.id,
        submission_state: submission.state,
      },
    });
    return {
      submission,
      broker_order_id: submission.broker_order_id ?? undefined,
      broker_provider: submission.broker_provider,
      asset_class: params.order.asset_class,
    };
  }

  if (submission.state !== "RESERVED" && submission.state !== "FAILED") {
    throw createError(ErrorCode.CONFLICT, `Order submission is in unexpected state: ${submission.state}`);
  }

  const transitioned = await tryTransitionOrderSubmissionState(
    params.db,
    submission.id,
    ["RESERVED", "FAILED"],
    "SUBMITTING"
  );
  if (!transitioned) {
    const latest = await getOrderSubmissionByIdempotencyKey(params.db, params.idempotency_key);
    if (latest) {
      if (isAcceptedSubmissionState(latest.state)) {
        return {
          submission: latest,
          broker_order_id: latest.broker_order_id ?? undefined,
          broker_provider: latest.broker_provider,
          asset_class: params.order.asset_class,
        };
      }
    }
    throw createError(ErrorCode.CONFLICT, "Unable to transition submission to SUBMITTING");
  }

  try {
    let policyResultForTrace: PolicyResult | null = null;
    let policyConfigForTrace: PolicyConfig | null = null;
    let riskStateForTrace: RiskState | null = null;

    const evaluation = await evaluateOrderPolicy({
      env: params.env,
      db: params.db,
      broker: params.broker,
      order: params.order,
    });
    policyResultForTrace = evaluation.policyResult;
    policyConfigForTrace = evaluation.policyConfig;
    riskStateForTrace = evaluation.riskState;

    if (evaluation.riskState.kill_switch_active) {
      await recordDecisionTraceSafe(params.db, {
        trace_id: traceId,
        request_id: params.idempotency_key,
        source: "execute-order",
        stage: "policy_gate",
        decision_kind: "policy",
        input: params.order,
        policy: {
          policy_result: evaluation.policyResult,
          policy_config: evaluation.policyConfig,
          risk_state: evaluation.riskState,
        },
        final_action: "blocked_kill_switch",
        status: "blocked",
        error_code: ErrorCode.KILL_SWITCH_ACTIVE,
        error_message: evaluation.riskState.kill_switch_reason ?? "Kill switch active",
        symbol: params.order.symbol,
        metadata: {
          approval_id: params.approval_id ?? null,
          source: params.source,
          submission_id: submission.id,
        },
      });
      throw createError(ErrorCode.KILL_SWITCH_ACTIVE, evaluation.riskState.kill_switch_reason ?? "Kill switch active");
    }
    const policyResult = evaluation.policyResult;
    if (!policyResult.allowed) {
      await recordDecisionTraceSafe(params.db, {
        trace_id: traceId,
        request_id: params.idempotency_key,
        source: "execute-order",
        stage: "policy_gate",
        decision_kind: "policy",
        input: params.order,
        policy: {
          policy_result: policyResult,
          policy_config: evaluation.policyConfig,
          risk_state: evaluation.riskState,
        },
        final_action: "blocked_policy_violation",
        status: "blocked",
        error_code: ErrorCode.POLICY_VIOLATION,
        error_message: "Policy blocked order",
        symbol: params.order.symbol,
        metadata: {
          approval_id: params.approval_id ?? null,
          source: params.source,
          submission_id: submission.id,
        },
      });
      throw createError(ErrorCode.POLICY_VIOLATION, "Policy blocked order", policyResult);
    }

    const isCrypto = params.order.asset_class === "crypto";
    if (!isCrypto && !evaluation.clock.is_open && params.order.time_in_force === "day") {
      await recordDecisionTraceSafe(params.db, {
        trace_id: traceId,
        request_id: params.idempotency_key,
        source: "execute-order",
        stage: "market_gate",
        decision_kind: "policy",
        input: params.order,
        policy: {
          policy_result: policyResult,
          policy_config: evaluation.policyConfig,
          risk_state: evaluation.riskState,
          market_clock: evaluation.clock,
        },
        final_action: "blocked_market_closed",
        status: "blocked",
        error_code: ErrorCode.MARKET_CLOSED,
        error_message: "Market closed",
        symbol: params.order.symbol,
        metadata: {
          approval_id: params.approval_id ?? null,
          source: params.source,
          submission_id: submission.id,
        },
      });
      throw createError(ErrorCode.MARKET_CLOSED, "Market closed");
    }

    const clientOrderId =
      params.idempotency_key.length <= 32
        ? params.idempotency_key
        : (await sha256Hex(params.idempotency_key)).slice(0, 32);

    const order = await params.broker.trading.createOrder({
      symbol: params.order.symbol,
      qty: params.order.qty,
      notional: params.order.notional,
      side: params.order.side,
      type: params.order.order_type,
      time_in_force: params.order.time_in_force,
      limit_price: params.order.limit_price,
      stop_price: params.order.stop_price,
      client_order_id: clientOrderId,
    });
    const effectiveBrokerProvider = order.broker_provider ?? params.broker.broker;
    const effectiveAssetClass: OrderPreview["asset_class"] = order.asset_class === "us_equity" ? "us_equity" : "crypto";

    await setOrderSubmissionState(params.db, submission.id, "SUBMITTED", {
      broker_order_id: order.id,
      broker_provider: effectiveBrokerProvider,
    });

    let tradeId: string | undefined;
    try {
      const isExecutedCrypto = effectiveAssetClass === "crypto";
      tradeId = await createTrade(params.db, {
        approval_id: params.approval_id ?? undefined,
        submission_id: submission.id,
        broker_provider: effectiveBrokerProvider,
        broker_order_id: order.id,
        alpaca_order_id: order.id,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty ? parseFloat(order.qty) : undefined,
        notional: params.order.notional,
        asset_class: effectiveAssetClass,
        quote_ccy: isExecutedCrypto ? params.env.OKX_DEFAULT_QUOTE_CCY : undefined,
        order_type: order.type,
        status: order.status,
        limit_price: params.order.limit_price,
        stop_price: params.order.stop_price,
      });
    } catch (tradeError) {
      await setOrderSubmissionState(params.db, submission.id, "SUBMITTED", {
        last_error_json: JSON.stringify({
          code: ErrorCode.INTERNAL_ERROR,
          message: "Trade persistence failed after broker submit",
          details: sanitizeForLog({ error: String(tradeError) }),
        }),
      });
    }

    await recordDecisionTraceSafe(params.db, {
      trace_id: traceId,
      request_id: params.idempotency_key,
      source: "execute-order",
      stage: "broker_submit",
      decision_kind: "execution",
      input: params.order,
      output: {
        submission_state: "SUBMITTED",
        broker_order_id: order.id,
        trade_id: tradeId ?? null,
      },
      policy: {
        policy_result: policyResultForTrace,
        policy_config: policyConfigForTrace,
        risk_state: riskStateForTrace,
      },
      final_action: "submitted",
      status: "success",
      symbol: params.order.symbol,
      metadata: {
        approval_id: params.approval_id ?? null,
        source: params.source,
        submission_id: submission.id,
        broker_provider: effectiveBrokerProvider,
      },
    });

    return {
      submission: {
        ...submission,
        state: "SUBMITTED",
        broker_order_id: order.id,
        broker_provider: effectiveBrokerProvider,
      },
      broker_order_id: order.id,
      trade_id: tradeId,
      broker_provider: effectiveBrokerProvider,
      asset_class: effectiveAssetClass,
    };
  } catch (err) {
    const toolError =
      err && typeof err === "object" && "code" in err && "message" in err
        ? (err as { code: string; message: string; details?: unknown })
        : { code: ErrorCode.PROVIDER_ERROR, message: String(err) };

    const latest = await getOrderSubmissionByIdempotencyKey(params.db, params.idempotency_key);
    if (latest?.state === "SUBMITTED" || latest?.broker_order_id) {
      await setOrderSubmissionState(params.db, latest.id, "SUBMITTED", {
        last_error_json: JSON.stringify({ ...toolError, details: sanitizeForLog(toolError.details) }),
      });
      return {
        submission: latest,
        broker_order_id: latest.broker_order_id ?? undefined,
        broker_provider: latest.broker_provider,
        asset_class: params.order.asset_class,
      };
    }

    await setOrderSubmissionState(params.db, submission.id, "FAILED", {
      last_error_json: JSON.stringify({ ...toolError, details: sanitizeForLog(toolError.details) }),
    });

    await recordDecisionTraceSafe(params.db, {
      trace_id: traceId,
      request_id: params.idempotency_key,
      source: "execute-order",
      stage: "broker_submit",
      decision_kind: "execution",
      input: params.order,
      output: {
        submission_state: "FAILED",
      },
      final_action: "submit_failed",
      status: "error",
      error_code: toolError.code,
      error_message: toolError.message,
      symbol: params.order.symbol,
      metadata: {
        approval_id: params.approval_id ?? null,
        source: params.source,
        submission_id: submission.id,
        broker_provider: params.broker.broker,
      },
    });

    if (err && typeof err === "object" && "code" in err && "message" in err) {
      throw err;
    }
    throw createError(ErrorCode.PROVIDER_ERROR, String(err));
  }
}
