import { describe, expect, it } from "vitest";
import { evaluateAlertRules } from "../alerts/rules";

describe("alert rules", () => {
  it("fires drawdown, kill-switch, DLQ, and llm-auth alerts", () => {
    const nowMs = 1_700_000_000_000;
    const alerts = evaluateAlertRules({
      environment: "test",
      nowMs,
      account: { equity: 800 },
      riskState: {
        kill_switch_active: true,
        kill_switch_reason: "manual emergency stop",
        kill_switch_at: new Date(nowMs - 1_000).toISOString(),
        daily_equity_start: 1_000,
        max_portfolio_drawdown_pct: 0.15,
      },
      policyConfig: {
        max_portfolio_drawdown_pct: 0.15,
      },
      swarm: {
        deadLettered: 12,
        queued: 5,
        staleAgents: 1,
      },
      llm: {
        last_auth_error: {
          at: nowMs - 30_000,
          message: "401 Unauthorized",
        },
      },
    });

    expect(alerts.map((a) => a.rule)).toEqual(
      expect.arrayContaining([
        "portfolio_drawdown",
        "kill_switch_active",
        "swarm_dead_letter_queue",
        "llm_auth_failure",
      ])
    );

    const drawdown = alerts.find((a) => a.rule === "portfolio_drawdown");
    const dlq = alerts.find((a) => a.rule === "swarm_dead_letter_queue");
    expect(drawdown?.severity).toBe("critical");
    expect(dlq?.severity).toBe("critical");
  });

  it("fires drawdown warning near threshold", () => {
    const alerts = evaluateAlertRules({
      environment: "test",
      nowMs: 1_700_000_000_000,
      account: { equity: 860 },
      riskState: {
        kill_switch_active: false,
        kill_switch_reason: null,
        kill_switch_at: null,
        daily_equity_start: 1_000,
        max_portfolio_drawdown_pct: 0.15,
      },
    });

    const drawdown = alerts.find((a) => a.rule === "portfolio_drawdown");
    expect(drawdown?.severity).toBe("warning");
  });

  it("ignores stale llm auth failures outside window", () => {
    const nowMs = 1_700_000_000_000;
    const alerts = evaluateAlertRules({
      environment: "test",
      nowMs,
      llm: {
        last_auth_error: {
          at: nowMs - 3_600_000,
          message: "expired key",
        },
      },
      thresholds: {
        llmAuthFailureWindowMs: 300_000,
      },
    });

    expect(alerts.find((a) => a.rule === "llm_auth_failure")).toBeUndefined();
  });
});
