import { describe, expect, it } from "vitest";
import { createTelemetry } from "../lib/telemetry";

describe("telemetry", () => {
  it("records counters with dimensions", () => {
    const telemetry = createTelemetry("test_scope");
    telemetry.increment("requests_total", 1, { route: "/health", method: "GET" });
    telemetry.increment("requests_total", 2, { route: "/health", method: "GET" });
    telemetry.increment("requests_total", 1, { route: "/metrics", method: "GET" });

    const snapshot = telemetry.snapshot();
    const metric = snapshot.counters.requests_total;
    expect(metric?.total).toBe(4);
    expect(metric?.by_dimension["method=GET,route=/health"]).toBe(3);
    expect(metric?.by_dimension["method=GET,route=/metrics"]).toBe(1);
  });

  it("records timer aggregates", () => {
    const telemetry = createTelemetry("test_scope");
    telemetry.recordDuration("latency_ms", 10, { route: "/a" });
    telemetry.recordDuration("latency_ms", 20, { route: "/a" });
    telemetry.recordDuration("latency_ms", 40, { route: "/b" });

    const snapshot = telemetry.snapshot();
    const metric = snapshot.timers.latency_ms;
    expect(metric?.count).toBe(3);
    expect(metric?.max_ms).toBe(40);
    expect(metric?.min_ms).toBe(10);
    expect(metric?.by_dimension["route=/a"]?.count).toBe(2);
    expect(metric?.by_dimension["route=/b"]?.avg_ms).toBe(40);
  });

  it("skips timer recording for non-finite durations", () => {
    const telemetry = createTelemetry("test_scope");
    telemetry.recordDuration("latency_ms", Number.NaN, { route: "/a" });
    telemetry.recordDuration("latency_ms", Number.POSITIVE_INFINITY, { route: "/a" });

    const snapshot = telemetry.snapshot();
    expect(snapshot.timers.latency_ms).toBeUndefined();
  });
});
