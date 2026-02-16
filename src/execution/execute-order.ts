import type { Env } from "../env.d";
import { createError, ErrorCode } from "../lib/errors";
import { sanitizeForLog, sha256Hex } from "../lib/utils";
import type { OrderPreview } from "../mcp/types";
import { getDefaultPolicyConfig } from "../policy/config";
import { PolicyEngine } from "../policy/engine";
import type { BrokerProviders } from "../providers/broker-factory";
import type { D1Client, OrderSubmissionRow } from "../storage/d1/client";
import {
  getOrderSubmissionByIdempotencyKey,
  reserveOrderSubmission,
  setOrderSubmissionState,
  tryTransitionOrderSubmissionState,
} from "../storage/d1/queries/order-submissions";
import { getPolicyConfig } from "../storage/d1/queries/policy-config";
import { getRiskState } from "../storage/d1/queries/risk-state";
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
}

export function isAcceptedSubmissionState(state: string): boolean {
  return state === "SUBMITTED" || state === "SUBMITTING";
}

export async function executeOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  const request_json = JSON.stringify({ order: params.order, approval_id: params.approval_id ?? null });
  const submission = await reserveOrderSubmission(params.db, {
    idempotency_key: params.idempotency_key,
    source: params.source,
    approval_id: params.approval_id ?? null,
    broker_provider: params.broker.broker,
    request_json,
  });

  if (isAcceptedSubmissionState(submission.state)) {
    return { submission, broker_order_id: submission.broker_order_id ?? undefined };
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
        return { submission: latest, broker_order_id: latest.broker_order_id ?? undefined };
      }
    }
    throw createError(ErrorCode.CONFLICT, "Unable to transition submission to SUBMITTING");
  }

  try {
    const riskState = await getRiskState(params.db);

    if (riskState.kill_switch_active) {
      throw createError(ErrorCode.KILL_SWITCH_ACTIVE, riskState.kill_switch_reason ?? "Kill switch active");
    }

    const [account, positions, clock] = await Promise.all([
      params.broker.trading.getAccount(),
      params.broker.trading.getPositions(),
      params.broker.trading.getClock(),
    ]);

    const config = (await getPolicyConfig(params.db)) ?? getDefaultPolicyConfig(params.env);
    const engine = new PolicyEngine(config);
    const policyResult = engine.evaluate({ order: params.order, account, positions, clock, riskState });
    if (!policyResult.allowed) {
      throw createError(ErrorCode.POLICY_VIOLATION, "Policy blocked order", policyResult);
    }

    const isCrypto = params.order.asset_class === "crypto";
    if (!isCrypto && !clock.is_open && params.order.time_in_force === "day") {
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

    await setOrderSubmissionState(params.db, submission.id, "SUBMITTED", { broker_order_id: order.id });

    let tradeId: string | undefined;
    try {
      tradeId = await createTrade(params.db, {
        approval_id: params.approval_id ?? undefined,
        submission_id: submission.id,
        broker_provider: params.broker.broker,
        broker_order_id: order.id,
        alpaca_order_id: order.id,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty ? parseFloat(order.qty) : undefined,
        notional: params.order.notional,
        asset_class: params.order.asset_class,
        quote_ccy: isCrypto ? params.env.OKX_DEFAULT_QUOTE_CCY : undefined,
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

    return {
      submission: { ...submission, state: "SUBMITTED", broker_order_id: order.id },
      broker_order_id: order.id,
      trade_id: tradeId,
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
      return { submission: latest, broker_order_id: latest.broker_order_id ?? undefined };
    }

    await setOrderSubmissionState(params.db, submission.id, "FAILED", {
      last_error_json: JSON.stringify({ ...toolError, details: sanitizeForLog(toolError.details) }),
    });

    if (err && typeof err === "object" && "code" in err && "message" in err) {
      throw err;
    }
    throw createError(ErrorCode.PROVIDER_ERROR, String(err));
  }
}
