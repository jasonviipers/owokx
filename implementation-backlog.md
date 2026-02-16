# Implementation Backlog

## Assumptions

- Sprint length: 2 weeks
- Team capacity: 32-36 SP per sprint
- Story point scale: 3 (S), 5 (M), 8 (L)
- Global Definition of Done for each ticket:
  - `pnpm run typecheck`
  - `pnpm run test:run`
  - `pnpm run check`
  - `pnpm --dir dashboard run check`

## Sprint Sizing

| Sprint | Tickets | SP |
|---|---|---:|
| Sprint 1 | A-01, A-02, B-01, C-01, D-01, D-02, D-03 | 34 |
| Sprint 2 | A-03, A-04, B-02, B-03, C-02 | 31 |
| Sprint 3 | C-03, C-04, E-01, E-02, E-03 | 34 |
| Sprint 4 | E-04, F-01, F-02, F-03, F-04 | 31 |

## Epic A: Harness Modularization (26 SP)

| ID | Ticket | SP | Files (mapped) | Acceptance criteria |
|---|---|---:|---|---|
| A-01 | Define harness module boundaries and shared context | 5 | `src/durable-objects/owokx-harness.ts`, `src/durable-objects/harness/types.ts` (new), `src/durable-objects/harness/context.ts` (new), `src/.test/owokx-harness.config-guard.test.ts` | Module contracts compile; `/agent/status` and `/agent/config` behavior unchanged. |
| A-02 | Extract signal and research services from monolith | 8 | `src/durable-objects/harness/signal-service.ts` (new), `src/durable-objects/harness/research-service.ts` (new), `src/durable-objects/owokx-harness.ts`, `src/durable-objects/data-scout-simple.ts`, `src/durable-objects/analyst-simple.ts`, `src/.test/data-scout-simple.test.ts`, `src/.test/analyst-simple.test.ts` | Same candidate ordering and fallback behavior under existing tests and fixtures. |
| A-03 | Extract execution orchestration service | 8 | `src/durable-objects/harness/execution-service.ts` (new), `src/execution/execute-order.ts`, `src/durable-objects/trader-simple.ts`, `src/durable-objects/owokx-harness.ts`, `src/.test/execute-order.test.ts`, `src/.test/trader-simple.test.ts` | Idempotency and policy gating unchanged; no duplicate submits in tests. |
| A-04 | Add harness route regression tests and finish cutover | 5 | `src/.test/owokx-harness.routes.test.ts` (new), `src/.test/index.swarm.test.ts`, `src/durable-objects/owokx-harness.ts` | Route tests for status/config/trigger/metrics pass; harness LOC reduced from baseline. |

## Epic B: Dashboard Decomposition (15 SP)

| ID | Ticket | SP | Files (mapped) | Acceptance criteria |
|---|---|---:|---|---|
| B-01 | Split `App.tsx` into page shell and primary pages | 5 | `dashboard/src/App.tsx`, `dashboard/src/main.tsx`, `dashboard/src/pages/OverviewPage.tsx` (new), `dashboard/src/pages/SwarmPage.tsx` (new), `dashboard/src/pages/SettingsPage.tsx` (new), `dashboard/src/components/Mobilenav.tsx` | Existing workflows remain available; dashboard build/check passes. |
| B-02 | Centralize API calls into client and hooks | 5 | `dashboard/src/lib/api.ts` (new), `dashboard/src/hooks/useAgentStatus.ts` (new), `dashboard/src/hooks/useSwarmMetrics.ts` (new), `dashboard/src/hooks/useLogs.ts` (new), `dashboard/src/App.tsx` | No direct `fetch` in page components for core polling flows; retry and timeout policy is unified. |
| B-03 | Decompose settings and sync state; add error boundaries | 5 | `dashboard/src/components/SettingsModal.tsx`, `dashboard/src/components/SwarmDashboard.tsx`, `dashboard/src/components/SetupWizard.tsx`, `dashboard/src/components/ErrorBoundary.tsx` (new), `dashboard/src/App.tsx` | Panel failures are isolated; app remains usable during partial API failures. |

## Epic C: Unified Risk Engine (26 SP)

| ID | Ticket | SP | Files (mapped) | Acceptance criteria |
|---|---|---:|---|---|
| C-01 | Introduce risk schema v2 migration and query defaults | 5 | `migrations/0007_risk_limits_v2.sql` (new), `src/storage/d1/queries/risk-state.ts`, `src/storage/d1/queries/policy-config.ts`, `src/env.d.ts` | Migration applies cleanly; old configs still load with safe defaults. |
| C-02 | Implement unified evaluator (drawdown tiers, symbol and correlation exposure) | 8 | `src/durable-objects/risk-manager.ts`, `src/policy/engine.ts`, `src/policy/config.ts`, `src/policy/approval.ts` | Same risk structure is used across manager and policy engine; new constraints enforceable via config. |
| C-03 | Wire unified risk into MCP and autonomous execution | 8 | `src/execution/execute-order.ts`, `src/mcp/agent.ts`, `src/durable-objects/trader-simple.ts`, `src/durable-objects/owokx-harness.ts` | `orders-preview` and runtime trader produce consistent allow/deny outcomes for the same context. |
| C-04 | Expand tests and expose new risk controls in UI | 5 | `src/.test/engine.test.ts`, `src/.test/execute-order.test.ts`, `src/.test/trader-simple.test.ts`, `dashboard/src/components/SettingsModal.tsx`, `dashboard/src/types.ts` | At least 12 new risk cases added; dashboard can read/write new risk fields. |

## Epic D: CI and Reliability Hardening (11 SP)

| ID | Ticket | SP | Files (mapped) | Acceptance criteria |
|---|---|---:|---|---|
| D-01 | Add CI matrix and stricter deployment gating | 3 | `.github/workflows/ci.yml`, `.github/workflows/deploy-oneclick.yml` | Matrix runs on Node 20/22 and Linux/Windows for worker tests; deploy is blocked on any lane failure. |
| D-02 | Emit test artifacts and flake visibility | 3 | `vitest.config.ts`, `.github/workflows/ci.yml` | JUnit and coverage artifacts uploaded; flaky rerun policy reported explicitly. |
| D-03 | Add critical integration tests for routing/import regression | 5 | `src/.test/http-routing.test.ts` (new), `src/.test/index.swarm.test.ts`, `src/.test/rate-limiter.test.ts`, `src/index.ts` | Fails on broken route proxy/auth paths and import-resolution regressions. |

## Epic E: Strategy Lab and Experimentation (26 SP)

| ID | Ticket | SP | Files (mapped) | Acceptance criteria |
|---|---|---:|---|---|
| E-01 | Add experiments schema and query layer | 5 | `migrations/0008_experiments.sql` (new), `src/storage/d1/queries/experiments.ts` (new), `src/storage/r2/paths.ts`, `src/storage/r2/client.ts` | Can persist runs/variants/metrics and retrieve them by strategy/date. |
| E-02 | Persist backtest runs and artifacts | 8 | `scripts/backtest.ts`, `src/providers/backtest.ts`, `src/storage/d1/queries/experiments.ts`, `src/jobs/cron.ts` | Backtest CLI stores summary and equity artifacts; deterministic seed is supported. |
| E-03 | Implement champion/challenger promotion flow | 8 | `src/durable-objects/learning-agent.ts`, `src/durable-objects/owokx-harness.ts`, `src/schemas/agent-config.ts`, `src/schemas/agent-config.test.ts` | Promotion requires configured thresholds; active strategy switch works without restart. |
| E-04 | Add experiment UI and docs/runbook | 5 | `dashboard/src/pages/ExperimentsPage.tsx` (new), `dashboard/src/lib/api.ts`, `dashboard/src/components/LineChart.tsx`, `README.md`, `docs/architecture.html` | Users can compare runs and promote strategy from dashboard; docs cover rollback. |

## Epic F: Decision Intelligence, Observability, and Alerts (26 SP)

| ID | Ticket | SP | Files (mapped) | Acceptance criteria |
|---|---|---:|---|---|
| F-01 | Capture end-to-end decision traces | 8 | `migrations/0009_decision_trace.sql` (new), `src/storage/d1/queries/decisions.ts`, `src/durable-objects/analyst-simple.ts`, `src/durable-objects/trader-simple.ts`, `src/execution/execute-order.ts`, `src/mcp/agent.ts` | Each order path has queryable trace with input hash, model/provider, policy, and final action. |
| F-02 | Add telemetry abstraction and metric expansion | 5 | `src/lib/telemetry.ts` (new), `src/index.ts`, `src/durable-objects/swarm-registry.ts`, `src/durable-objects/owokx-harness.ts` | Standard counters/timers emitted for latency/error/cost dimensions; `/metrics` remains backward compatible. |
| F-03 | Implement alert rules and notifier integrations | 8 | `src/alerts/rules.ts` (new), `src/alerts/notifier.ts` (new), `src/jobs/cron.ts`, `src/env.d.ts`, `wrangler.jsonc` | Rules for drawdown/kill-switch/DLQ/LLM failure fire correctly; notifications are deduped and rate-limited. |
| F-04 | Add alert management in MCP and dashboard | 5 | `src/mcp/agent.ts`, `src/mcp/types.ts`, `dashboard/src/pages/AlertsPage.tsx` (new), `dashboard/src/components/NotificationBell.tsx`, `dashboard/src/types.ts` | Create/list/ack alert rules via MCP; dashboard supports rule CRUD and history view. |

## Dependency Order

1. A-01 -> A-02 -> A-03 -> A-04
2. C-01 -> C-02 -> C-03 -> C-04
3. E-01 -> E-02 -> E-03 -> E-04
4. F-01 and F-02 before F-03 and F-04
