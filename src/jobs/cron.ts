import { createAlertNotifier } from "../alerts/notifier";
import { type AlertRuleThresholds, evaluateAlertRules } from "../alerts/rules";
import type { Env } from "../env.d";
import { parseNumber } from "../lib/utils";
import { getDefaultPolicyConfig } from "../policy/config";
import { persistBacktestRunArtifacts } from "../providers/backtest";
import { createBrokerProviders } from "../providers/broker-factory";
import { createSECEdgarProvider } from "../providers/news/sec-edgar";
import { createD1Client } from "../storage/d1/client";
import { listAlertRules, recordAlertEventsBatch } from "../storage/d1/queries/alerts";
import { cleanupExpiredApprovals } from "../storage/d1/queries/approvals";
import { insertRawEvent, rawEventExists } from "../storage/d1/queries/events";
import { getSubmittedOrderSubmissionsMissingTrades } from "../storage/d1/queries/order-submissions";
import { getPolicyConfig } from "../storage/d1/queries/policy-config";
import { getRiskState, resetDailyLoss, setDailyLossAbsolute } from "../storage/d1/queries/risk-state";
import { createTrade, updateTradeStatus } from "../storage/d1/queries/trades";

export async function handleCronEvent(cronId: string, env: Env): Promise<void> {
  switch (cronId) {
    case "*/5 13-20 * * 1-5":
      await runEventIngestion(env);
      break;

    case "0 14 * * 1-5":
      await runMarketOpenPrep(env);
      break;

    case "30 21 * * 1-5":
      await runMarketCloseCleanup(env);
      break;

    case "0 5 * * *":
      await runMidnightReset(env);
      break;

    case "0 * * * *":
      await runHourlyCacheRefresh(env);
      break;

    default:
      console.log(`Unknown cron: ${cronId}`);
  }
}

async function runEventIngestion(env: Env): Promise<void> {
  console.log("Starting event ingestion...");

  const db = createD1Client(env.DB);
  const broker = createBrokerProviders(env);

  try {
    const clock = await broker.trading.getClock();

    if (!clock.is_open) {
      console.log("Market closed, skipping event ingestion");
      return;
    }

    const riskState = await getRiskState(db);
    if (riskState.kill_switch_active) {
      console.log("Kill switch active, skipping event ingestion");
      return;
    }

    const secProvider = createSECEdgarProvider();
    const events = await secProvider.poll();

    let newEvents = 0;
    for (const event of events) {
      const exists = await rawEventExists(db, event.source, event.source_id);
      if (!exists) {
        await insertRawEvent(db, {
          source: event.source,
          source_id: event.source_id,
          raw_content: event.content,
        });
        newEvents++;
      }
    }

    console.log(`Event ingestion complete: ${newEvents} new events`);
  } catch (error) {
    console.error("Event ingestion error:", error);
  }
}

async function runMarketOpenPrep(env: Env): Promise<void> {
  console.log("Running market open prep...");

  const db = createD1Client(env.DB);

  try {
    const riskState = await getRiskState(db);
    console.log(
      `Risk state at open: kill_switch=${riskState.kill_switch_active}, daily_loss=${riskState.daily_loss_usd}`
    );

    const cleaned = await cleanupExpiredApprovals(db);
    console.log(`Cleaned up ${cleaned} expired approvals`);
  } catch (error) {
    console.error("Market open prep error:", error);
  }
}

async function runMarketCloseCleanup(env: Env): Promise<void> {
  console.log("Running market close cleanup...");

  const db = createD1Client(env.DB);
  const broker = createBrokerProviders(env);

  try {
    const positions = await broker.trading.getPositions();
    const account = await broker.trading.getAccount();

    console.log(`End of day: ${positions.length} positions, equity=${account.equity}`);

    const cleaned = await cleanupExpiredApprovals(db);
    console.log(`Cleaned up ${cleaned} expired approvals`);
  } catch (error) {
    console.error("Market close cleanup error:", error);
  }
}

async function runMidnightReset(env: Env): Promise<void> {
  console.log("Running midnight reset...");

  const db = createD1Client(env.DB);
  let equityStartUsd: number | null = null;

  try {
    try {
      const broker = createBrokerProviders(env);
      const account = await broker.trading.getAccount();
      equityStartUsd = Number.isFinite(account.equity) ? account.equity : null;
    } catch {
      equityStartUsd = null;
    }

    await resetDailyLoss(db, { equityStartUsd });
    console.log("Daily loss counter reset", { equityStartUsd });

    const cleaned = await cleanupExpiredApprovals(db);
    console.log(`Cleaned up ${cleaned} expired approvals`);
  } catch (error) {
    console.error("Midnight reset error:", error);
  }
}

/**
 * Format a Date as a New York–time date string in YYYY-MM-DD format.
 *
 * @param d - The Date to format in the America/New_York timezone
 * @returns The formatted date string in `YYYY-MM-DD` (en-CA) form
 */
function nyDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

interface SwarmQueueStateSnapshot {
  deadLettered: number;
  queued: number;
  staleAgents: number;
}

interface HarnessLlmSnapshot {
  last_auth_error: {
    at?: number;
    message?: string;
  } | null;
}

function isMissingAlertsSchemaError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("no such table") && (message.includes("alert_rules") || message.includes("alert_events"));
}

function toAlertThresholds(env: Env): Partial<AlertRuleThresholds> {
  return {
    drawdownWarnRatio: parseNumber(env.ALERT_DRAWDOWN_WARN_RATIO, 0.8),
    deadLetterWarn: parseNumber(env.ALERT_DLQ_WARN_THRESHOLD, 1),
    deadLetterCritical: parseNumber(env.ALERT_DLQ_CRITICAL_THRESHOLD, 10),
    llmAuthFailureWindowMs: parseNumber(env.ALERT_LLM_AUTH_WINDOW_SECONDS, 900) * 1000,
  };
}

/**
 * Retrieves the swarm queue state snapshot from the configured swarm registry.
 *
 * @returns The snapshot with counts for `deadLettered`, `queued`, and `staleAgents`, or `null` if no registry is configured, the request fails, or the response is missing/invalid.
 */
async function fetchSwarmQueueState(env: Env): Promise<SwarmQueueStateSnapshot | null> {
  if (!env.SWARM_REGISTRY) return null;

  try {
    const registryId = env.SWARM_REGISTRY.idFromName("default");
    const registry = env.SWARM_REGISTRY.get(registryId);
    const response = await registry.fetch("http://registry/queue/state");
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      deadLettered?: number;
      queued?: number;
      staleAgents?: number;
    };

    return {
      deadLettered: Number.isFinite(payload.deadLettered) ? Number(payload.deadLettered) : 0,
      queued: Number.isFinite(payload.queued) ? Number(payload.queued) : 0,
      staleAgents: Number.isFinite(payload.staleAgents) ? Number(payload.staleAgents) : 0,
    };
  } catch (error) {
    console.error("[alerts] swarm_queue_fetch_failed", String(error));
    return null;
  }
}

/**
 * Fetches the latest LLM authentication error snapshot from the configured Harness service.
 *
 * @returns A `HarnessLlmSnapshot` containing `last_auth_error` (with optional `at` timestamp and `message`), or `null` if the Harness is not configured or the snapshot could not be retrieved.
 */
async function fetchHarnessLlmSnapshot(env: Env): Promise<HarnessLlmSnapshot | null> {
  if (!env.OWOKX_HARNESS) return null;

  try {
    const harnessId = env.OWOKX_HARNESS.idFromName("main");
    const harness = env.OWOKX_HARNESS.get(harnessId);
    const token = env.OWOKX_API_TOKEN_READONLY || env.OWOKX_API_TOKEN;
    const response = await harness.fetch(
      new Request("http://harness/metrics", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
    );
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      data?: {
        llm?: {
          last_auth_error?: {
            at?: number;
            message?: string;
          } | null;
        };
      };
    };

    return {
      last_auth_error: payload.data?.llm?.last_auth_error ?? null,
    };
  } catch (error) {
    console.error("[alerts] harness_metrics_fetch_failed", String(error));
    return null;
  }
}

/**
 * Evaluate alert rules using the current account, risk state, and policy configuration, and dispatch any generated alerts.
 *
 * This function fetches external telemetry (swarm queue state and harness LLM snapshot), evaluates configured alert rules against
 * the provided account and risk state, and, if any alerts are produced, sends notifications and logs a dispatch summary.
 *
 * @param env - Runtime environment bindings and configuration used to fetch external state and create the alert notifier
 * @param input - Current runtime inputs for evaluation:
 *   - `account`: current account snapshot (uses `equity`)
 *   - `riskState`: current risk system state (kill switch, daily equity start, drawdown metrics)
 *   - `policyConfig`: policy-derived thresholds used by alert rules
 */
async function runAlertEvaluations(
  db: ReturnType<typeof createD1Client>,
  env: Env,
  input: {
    account: { equity: number };
    riskState: {
      kill_switch_active: boolean;
      kill_switch_reason: string | null;
      kill_switch_at: string | null;
      daily_equity_start: number | null;
      max_portfolio_drawdown_pct: number;
    };
    policyConfig: {
      max_portfolio_drawdown_pct: number;
    };
  }
): Promise<void> {
  const [swarm, llm] = await Promise.all([fetchSwarmQueueState(env), fetchHarnessLlmSnapshot(env)]);
  const evaluatedAlerts = evaluateAlertRules({
    environment: env.ENVIRONMENT,
    account: input.account,
    riskState: input.riskState,
    policyConfig: input.policyConfig,
    swarm,
    llm,
    thresholds: toAlertThresholds(env),
  });

  let alerts = evaluatedAlerts;
  try {
    const managedRules = await listAlertRules(db);
    const ruleMap = new Map(managedRules.map((rule) => [rule.id, rule]));
    alerts = evaluatedAlerts.flatMap((alert) => {
      const managedRule = ruleMap.get(alert.rule);
      if (!managedRule || !managedRule.enabled) {
        return [];
      }

      const severityOverride = managedRule.config?.severity_override;
      const finalSeverity =
        severityOverride === "info" || severityOverride === "warning" || severityOverride === "critical"
          ? severityOverride
          : alert.severity;

      return [{ ...alert, severity: finalSeverity }];
    });

    if (alerts.length > 0) {
      await recordAlertEventsBatch(
        db,
        alerts.map((alert) => ({
          id: alert.id,
          rule_id: alert.rule,
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          fingerprint: alert.fingerprint,
          details: alert.details,
          occurred_at: alert.occurred_at,
        }))
      );
    }
  } catch (error) {
    if (!isMissingAlertsSchemaError(error)) {
      console.warn("[alerts] persistence_failed", String(error));
    }
  }

  if (alerts.length === 0) return;

  const notifier = createAlertNotifier(env);
  const result = await notifier.notify(alerts);

  console.log(
    "[alerts] dispatch_result",
    JSON.stringify({
      attempted_rules: alerts.length,
      ...result,
    })
  );
}

/**
 * Performs hourly maintenance: refreshes risk and account state, updates daily-loss tracking, evaluates and dispatches alerts, backfills missing trades, and persists a live hourly snapshot.
 *
 * @param env - Environment bindings and configuration used to create the database and broker clients, derive policy defaults, and persist artifacts
 */
async function runHourlyCacheRefresh(env: Env): Promise<void> {
  console.log("Running hourly cache refresh...");
  const db = createD1Client(env.DB);

  let broker: ReturnType<typeof createBrokerProviders>;
  try {
    broker = createBrokerProviders(env);
  } catch (error) {
    console.error("Hourly refresh: broker init failed:", error);
    return;
  }

  try {
    const [riskState, account, policyConfigStored] = await Promise.all([
      getRiskState(db),
      broker.trading.getAccount(),
      getPolicyConfig(db),
    ]);
    const policyConfig = policyConfigStored ?? getDefaultPolicyConfig(env);

    const now = new Date();
    const nowNy = nyDateString(now);
    const resetNy = riskState.daily_loss_reset_at ? nyDateString(new Date(riskState.daily_loss_reset_at)) : null;
    if (resetNy !== nowNy) {
      await resetDailyLoss(db, { equityStartUsd: account.equity });
    }

    let dailyLossUsd = 0;
    if (broker.broker === "alpaca") {
      try {
        const history = await broker.trading.getPortfolioHistory({
          period: "1D",
          timeframe: "1Min",
          pnl_reset: "per_day",
        });
        const last = history.profit_loss[history.profit_loss.length - 1] ?? 0;
        dailyLossUsd = Math.max(0, -last);
      } catch {
        const baseline = riskState.daily_equity_start ?? account.equity;
        dailyLossUsd = Math.max(0, baseline - account.equity);
      }
    } else {
      const baseline = riskState.daily_equity_start ?? account.equity;
      dailyLossUsd = Math.max(0, baseline - account.equity);
    }

    const shouldUpdate = Math.abs((riskState.daily_loss_usd ?? 0) - dailyLossUsd) > 0.01;
    if (shouldUpdate) {
      const isNewLossEvent = dailyLossUsd > (riskState.daily_loss_usd ?? 0) + 0.01 && dailyLossUsd > 0;
      const cooldownMinutes = policyConfig.cooldown_minutes_after_loss ?? 0;

      if (isNewLossEvent && cooldownMinutes > 0) {
        const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
        await setDailyLossAbsolute(db, dailyLossUsd, {
          last_loss_at: now.toISOString(),
          cooldown_until: cooldownUntil,
        });
      } else {
        await setDailyLossAbsolute(db, dailyLossUsd);
      }
    }

    try {
      await runAlertEvaluations(db, env, {
        account,
        riskState,
        policyConfig,
      });
    } catch (error) {
      console.error("[alerts] hourly_evaluation_failed", {
        error: String(error),
        account_id: account.id,
        account_number: account.account_number,
        broker: broker.broker,
      });
    }

    const missingTrades = await getSubmittedOrderSubmissionsMissingTrades(db, 100);
    if (missingTrades.length > 0) {
      const brokers = new Map<string, ReturnType<typeof createBrokerProviders>>();

      for (const sub of missingTrades) {
        const brokerId = sub.broker_provider;
        const orderId = sub.broker_order_id;
        if (!brokerId || !orderId) continue;

        let brokerForRow = brokers.get(brokerId);
        if (!brokerForRow) {
          try {
            brokerForRow = createBrokerProviders(env, brokerId);
            brokers.set(brokerId, brokerForRow);
          } catch {
            continue;
          }
        }

        let order;
        try {
          order = await brokerForRow.trading.getOrder(orderId);
        } catch {
          continue;
        }

        let requested: { order?: { notional?: number; qty?: number; asset_class?: string } } | null = null;
        try {
          requested = JSON.parse(sub.request_json) as {
            order?: { notional?: number; qty?: number; asset_class?: string };
          };
        } catch {
          requested = null;
        }

        const tradeId = await createTrade(db, {
          approval_id: sub.approval_id ?? undefined,
          alpaca_order_id: order.id,
          submission_id: sub.id,
          broker_provider: brokerId,
          broker_order_id: order.id,
          symbol: order.symbol,
          side: order.side,
          qty: order.qty ? parseFloat(order.qty) : undefined,
          notional: requested?.order?.notional,
          asset_class: requested?.order?.asset_class ?? order.asset_class,
          quote_ccy:
            (requested?.order?.asset_class ?? order.asset_class) === "crypto" ? env.OKX_DEFAULT_QUOTE_CCY : undefined,
          order_type: order.type,
          limit_price: order.limit_price ? parseFloat(order.limit_price) : undefined,
          stop_price: order.stop_price ? parseFloat(order.stop_price) : undefined,
          status: order.status,
        });

        const filledQty = order.filled_qty ? parseFloat(order.filled_qty) : undefined;
        const filledAvgPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : undefined;
        await updateTradeStatus(db, tradeId, order.status, filledQty, filledAvgPrice);
      }
    }

    try {
      const snapshotAt = new Date().toISOString();
      const openPositionsCount = (await broker.trading.getPositions()).length;
      await persistBacktestRunArtifacts({
        db,
        artifacts: env.ARTIFACTS,
        strategy: "live_hourly_snapshot",
        variant_name: env.ENVIRONMENT,
        seed: Math.floor(Date.now() / 3_600_000),
        config: {
          source: "cron.hourly",
          broker: broker.broker,
          environment: env.ENVIRONMENT,
        },
        summary: {
          model: "live-snapshot",
          strategy: "live_hourly_snapshot",
          variant: env.ENVIRONMENT,
          seed: Math.floor(Date.now() / 3_600_000),
          steps: 1,
          orders: missingTrades.length,
          start_equity: account.equity,
          end_equity: account.equity,
          pnl: 0,
          pnl_pct: 0,
          max_drawdown_pct: 0,
          created_at: snapshotAt,
        },
        equity_curve: [{ t_ms: Date.now(), equity: account.equity, cash: account.cash }],
        metrics: [
          { metric_name: "daily_loss_usd", metric_value: dailyLossUsd },
          {
            metric_name: "kill_switch_active",
            metric_value: riskState.kill_switch_active ? 1 : 0,
          },
          { metric_name: "open_positions", metric_value: openPositionsCount },
        ],
        status: "completed",
        started_at: snapshotAt,
        finished_at: snapshotAt,
      });
    } catch (error) {
      console.error("Hourly refresh experiment snapshot error:", error);
    }
  } catch (error) {
    console.error("Hourly refresh error:", error);
  }
}
