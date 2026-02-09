# High-Impact Review Findings & Actionable Fixes

## 1) Multi-agent orchestration reliability: no liveness enforcement or quorum gating
**Finding:** SwarmRegistry records heartbeats but OwokxHarness does not gate trading on agent liveness or quorum; a stale data scout or risk manager can silently degrade decision quality. The registry stores lastHeartbeat but there is no consumer-side enforcement or health-based gating before trade decisions. 【F:src/durable-objects/swarm-registry.ts†L6-L72】【F:src/durable-objects/owokx-harness.ts†L909-L1005】

**Fix:** Require a minimum agent quorum and max heartbeat age before executing the trade loop. Add a pre-trade health check that queries SwarmRegistry and blocks trading (or switches to read-only mode) when required agents are stale. Emit a structured “orchestration_degraded” log and surface to dashboard.

## 2) Deterministic vs stochastic behavior: non-deterministic LLM outputs drive live decisions
**Finding:** LLM outputs are used in research and risk analysis without deterministic controls or guardrails; prompts request JSON but there is no temperature/seed enforcement or schema validation before consuming outputs. This creates non-repeatable behavior and unstable execution decisions. 【F:src/durable-objects/owokx-harness.ts†L2633-L2721】【F:src/providers/llm/openai.ts†L63-L73】

**Fix:** Set temperature to 0 for production, enforce strict JSON schema validation (reject & fallback to HOLD), and cache LLM decisions with input hashes to make behavior repeatable for identical inputs. Add a “deterministic_mode” config toggle and log stochastic runs explicitly.

## 3) Tool isolation & permission boundaries: kill switch is only in execution path
**Finding:** The kill switch is enforced in execute-order, but trading decisions and agent actions can still proceed up to the execution boundary. This allows continued research/trade preparation even when kill switch is active, increasing operational risk. 【F:src/execution/execute-order.ts†L76-L90】【F:src/durable-objects/owokx-harness.ts†L1271-L1425】

**Fix:** Enforce kill-switch checks at the start of the agent loop and before any order creation. Block data-driven trade generation and return a “disabled” status, ensuring no side effects or queued actions while disabled.

## 4) Market data integrity & timing risks: weak freshness/validation checks
**Finding:** Market snapshots are fetched and consumed without strict freshness validation or price staleness enforcement, particularly in the crypto snapshot paths. This risks trading on stale or delayed quotes. 【F:src/durable-objects/owokx-harness.ts†L1721-L1737】【F:src/durable-objects/owokx-harness.ts†L2481-L2490】

**Fix:** Add per-snapshot timestamp validation and reject data older than a configured max age (e.g., 5–10 seconds for crypto). Record “stale_quote” events and block trade execution if data is stale.

## 5) Risk management enforcement: daily loss tracking is simplistic and realized-only
**Finding:** RiskManager updates dailyLoss by subtracting realized PnL and does not include unrealized drawdown, open risk, or portfolio-level stop logic; there is no enforcement before order sizing. 【F:src/durable-objects/risk-manager.ts†L66-L88】【F:src/durable-objects/owokx-harness.ts†L2923-L3190】

**Fix:** Track equity high-water mark, unrealized PnL, and open exposure. Enforce max daily drawdown and max open risk before generating trades. Integrate RiskManager checks into the decision stage (not only execution).

## 6) Backtesting vs live trading drift: backtest broker omits live frictions
**Finding:** Backtest provider uses configurable spread, but there is no slippage model, partial fill simulation, or latency; live trading will deviate materially. 【F:src/providers/backtest.test.ts†L12-L49】【F:src/providers/types.ts†L222-L292】

**Fix:** Add slippage/latency models and partial fill simulation in backtest broker. Persist “live vs backtest drift” metrics in logs to monitor performance divergence.

## 7) Capital preservation logic: only static limits, no adaptive de-risking
**Finding:** Config enforces max position value and static stop/take-profit but lacks dynamic risk-off modes for volatility spikes or multiple losses. 【F:src/durable-objects/owokx-harness.ts†L62-L120】【F:src/schemas/agent-config.ts†L3-L75】

**Fix:** Add adaptive risk tiering: reduce max position size and tighten stops after a sequence of losses or volatility surge; implement a time-based cooldown before re-entry after stop-outs.