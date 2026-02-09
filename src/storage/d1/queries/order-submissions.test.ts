import { describe, expect, it } from "vitest";
import { reserveOrderSubmission } from "./order-submissions";

type Row = {
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

describe("reserveOrderSubmission", () => {
  it("inserts then loads the row by idempotency_key", async () => {
    const rows = new Map<string, Row>();

    const db = {
      async run(_query: string, params: unknown[]) {
        const [id, idempotencyKey, source, approvalId, brokerProvider, requestJson, createdAt, updatedAt] = params as [
          string,
          string,
          string,
          string | null,
          string,
          string,
          string,
          string,
        ];

        if (!rows.has(idempotencyKey)) {
          rows.set(idempotencyKey, {
            id,
            idempotency_key: idempotencyKey,
            source,
            approval_id: approvalId,
            broker_provider: brokerProvider,
            request_json: requestJson,
            state: "RESERVED",
            broker_order_id: null,
            last_error_json: null,
            created_at: createdAt,
            updated_at: updatedAt,
          });
        }
        return { meta: { changes: 1 } } as any;
      },
      async executeOne<T>(_query: string, params: unknown[]) {
        const [idempotencyKey] = params as [string];
        return (rows.get(idempotencyKey) ?? null) as T | null;
      },
    } as any;

    const row = await reserveOrderSubmission(db, {
      idempotency_key: "k1",
      source: "mcp",
      approval_id: "app_1",
      broker_provider: "alpaca",
      request_json: "{}",
    });

    expect(row.idempotency_key).toBe("k1");
    expect(row.source).toBe("mcp");
    expect(row.approval_id).toBe("app_1");
    expect(row.broker_provider).toBe("alpaca");
    expect(row.state).toBe("RESERVED");
  });
});
