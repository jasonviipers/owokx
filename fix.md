# Critical Fixes — Owokx Trading System

Three critical issues where the code **looks wired but is not**. Each section shows exactly what to delete, what to add, and why.

---

## Fix 1 — `risk-manager.ts`: Expose HTTP endpoints

**Problem:** `RiskManager` only handles messages via `AgentBase`'s internal protocol. `OwokxHarness` calls it via `stub.fetch()` (HTTP), so it can never reach the validation logic. `validateOrder()`, `calculateRiskState()`, and the kill-switch state are all unreachable from outside the DO.

**File:** `src/durable-objects/risk-manager.ts`

Add a `fetch()` override **inside the class**, after the constructor:

```typescript
// ADD THIS — HTTP interface so Harness can reach RiskManager via stub.fetch()
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Called by Harness.executeBuy() before every order
  if (url.pathname === "/validate") {
    const order = await request.json() as {
      symbol: string;
      notional: number;   // dollar size (not qty * price)
      side: "buy" | "sell";
    };
    const result = this.validateOrder({
      symbol: order.symbol,
      size: order.notional,
      side: order.side,
      price: 1, // notional already computed; price=1 keeps the check: size*1 = notional
    });
    return Response.json(result);
  }

  // Called by Harness.checkKillSwitch()
  if (url.pathname === "/status") {
    return Response.json({
      killSwitchActive: this.state.killSwitchActive,
      dailyLoss: this.state.dailyLoss,
      maxDailyLoss: this.state.maxDailyLoss,
    });
  }

  // Called by Harness.executeSell() after a trade closes to update PnL
  if (url.pathname === "/update-loss" && request.method === "POST") {
    const { profitLoss } = await request.json() as { profitLoss: number };
    await this.updateDailyLoss({ profitLoss });
    return Response.json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}
```

Also fix `validateOrder` — the current check `order.size * order.price` is wrong when called with `price: 1` and a notional directly. Rename the internal field to be explicit:

```typescript
// REPLACE the existing validateOrder signature + notional check with:
private validateOrder(order: {
  symbol: string;
  size: number;   // already a dollar notional
  side: "buy" | "sell";
  price: number;  // kept for signature compat; ignored when size is notional
}): { approved: boolean; reason?: string } {
  if (this.state.killSwitchActive) {
    return { approved: false, reason: "Kill switch is active" };
  }
  if (this.state.dailyLoss >= this.state.maxDailyLoss) {
    return { approved: false, reason: `Max daily loss exceeded ($${this.state.dailyLoss.toFixed(2)} / $${this.state.maxDailyLoss})` };
  }
  // order.size IS the notional dollar amount
  if (order.side === "buy" && order.size > 5000) {
    return { approved: false, reason: `Order notional ($${order.size.toFixed(2)}) exceeds per-trade limit ($5000)` };
  }
  return { approved: true };
}
```

---

## Fix 2 — `owokx-harness.ts`: Wire `checkKillSwitch()` to RiskManager

**Problem:** `checkKillSwitch()` only reads `this.env.KILL_SWITCH_ACTIVE`, a **static** env var that never changes at runtime. When `RiskManager` activates its kill switch (e.g. max daily loss hit), the Harness never sees it and keeps trading.

**File:** `src/durable-objects/owokx-harness.ts` — line ~927

**Replace** the entire `checkKillSwitch` method:

```typescript
// BEFORE (broken — never reads RiskManager state)
private async checkKillSwitch(): Promise<boolean> {
  if (!this.state.enabled) return true;
  if (this.env.KILL_SWITCH_ACTIVE === "true") return true;
  return false;
}
```

```typescript
// AFTER — checks static env var AND live RiskManager state
private async checkKillSwitch(): Promise<boolean> {
  if (!this.state.enabled) return true;

  // Fast path: static env var override (set in wrangler.toml secrets for emergencies)
  if (this.env.KILL_SWITCH_ACTIVE === "true") return true;

  // Live path: query RiskManager DO for its current kill-switch state
  if (this.env.RISK_MANAGER) {
    try {
      const id   = this.env.RISK_MANAGER.idFromName("main");
      const stub = this.env.RISK_MANAGER.get(id);
      const res  = await stub.fetch("http://risk/status");

      if (res.ok) {
        const { killSwitchActive } = await res.json() as { killSwitchActive: boolean };
        if (killSwitchActive) {
          this.log("System", "kill_switch_from_risk_manager", {
            reason: "RiskManager kill switch is active (daily loss limit hit)",
          });
          return true;
        }
      }
    } catch (e) {
      // Do NOT fail open — if we can't reach RiskManager, block trading
      this.log("System", "kill_switch_check_failed", {
        error: String(e),
        action: "blocking_trading_as_precaution",
      });
      return true;
    }
  }

  return false;
}
```

> **Why fail closed?** If RiskManager is unreachable (crashed, deploying), the safer default is to stop trading rather than continue without risk limits. Change `return true` to `return false` at the catch site only if you prefer fail-open behaviour.

---

## Fix 3 — `owokx-harness.ts`: Replace the placeholder in `executeBuy()`

**Problem:** The `RISK_MANAGER` block in `executeBuy()` logs `"risk_check_placeholder"` and does nothing. Every buy order bypasses per-order validation entirely regardless of kill-switch or daily-loss state.

**File:** `src/durable-objects/owokx-harness.ts` — line ~3257

**Replace** the entire placeholder block (lines 3257–3291):

```typescript
// BEFORE — 35 lines of comments that do nothing
if (this.env.RISK_MANAGER) {
  try {
    const positions = existingPositions || await broker.trading.getPositions();
    const id = this.env.RISK_MANAGER.idFromName("main");
    const stub = this.env.RISK_MANAGER.get(id);
    // ... [30 lines of confused comments] ...
    this.log("Executor", "risk_check_placeholder", { ... });
  } catch (e) {
    this.log("Executor", "risk_check_failed", { error: String(e) });
  }
}
```

```typescript
// AFTER — actually validates the order
if (this.env.RISK_MANAGER) {
  try {
    // Compute notional here so RiskManager sees the real dollar size
    const tentativeSizePct = Math.min(20, this.getAdaptivePositionSizePct(account));
    const tentativeNotional = Math.min(
      account.cash * (tentativeSizePct / 100) * confidence,
      this.state.config.max_position_value
    );

    const id   = this.env.RISK_MANAGER.idFromName("main");
    const stub = this.env.RISK_MANAGER.get(id);
    const res  = await stub.fetch("http://risk/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        notional: Math.round(tentativeNotional * 100) / 100,
        side: "buy",
      }),
    });

    if (res.ok) {
      const { approved, reason } = await res.json() as {
        approved: boolean;
        reason?: string;
      };
      if (!approved) {
        this.log("Executor", "buy_blocked_by_risk_manager", { symbol, reason });
        return false;
      }
    } else {
      // RiskManager returned an error — fail closed
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
```

---

## Bonus Fix — Report realized PnL back to RiskManager after a sell

`updateDailyLoss()` exists on `RiskManager` but is never called. Without this, daily loss never accumulates and the kill-switch threshold can never trigger automatically.

**File:** `src/durable-objects/owokx-harness.ts` — inside `executeSell()`, after a successful submission

Find this block (around line 3380):

```typescript
if (execution.submission.state === "SUBMITTED") {
  delete this.state.positionEntries[pos.symbol];
  delete this.state.socialHistory[pos.symbol];
  delete this.state.stalenessAnalysis[pos.symbol];
}
```

Add the PnL report **inside** the same `if` block:

```typescript
if (execution.submission.state === "SUBMITTED") {
  delete this.state.positionEntries[pos.symbol];
  delete this.state.socialHistory[pos.symbol];
  delete this.state.stalenessAnalysis[pos.symbol];

  // Report realized PnL to RiskManager so it can track daily loss
  if (this.env.RISK_MANAGER) {
    const realizedPnl = pos.unrealized_pl ?? 0; // best estimate at time of sell
    this.env.RISK_MANAGER.get(
      this.env.RISK_MANAGER.idFromName("main")
    ).fetch("http://risk/update-loss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profitLoss: realizedPnl }),
    }).catch((e) => {
      // Non-blocking — sell already submitted, don't throw
      this.log("Executor", "risk_pnl_report_failed", { symbol: pos.symbol, error: String(e) });
    });
  }
}
```

---

## `env.d.ts` — Add the binding if missing

If `RISK_MANAGER` is not yet declared in your environment types, add it:

```typescript
interface Env {
  // ... existing bindings ...
  RISK_MANAGER: DurableObjectNamespace;  // ADD
}
```

And in `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name        = "RISK_MANAGER"
class_name  = "RiskManager"

[[migrations]]
tag         = "v2"
new_classes = ["RiskManager"]
```

---

## Summary of Changes

| File | Change | Effect |
|---|---|---|
| `risk-manager.ts` | Add `fetch()` with `/validate`, `/status`, `/update-loss` routes | Makes RiskManager reachable over DO stub HTTP |
| `owokx-harness.ts` | Rewrite `checkKillSwitch()` | Kill switch now reads live RiskManager state every cycle |
| `owokx-harness.ts` | Replace placeholder in `executeBuy()` | Every buy is validated against daily loss + per-order cap |
| `owokx-harness.ts` | Report PnL in `executeSell()` | Daily loss accumulator actually works; auto kill-switch can trigger |
| `env.d.ts` + `wrangler.toml` | Add `RISK_MANAGER` binding | Required for DO stub resolution |