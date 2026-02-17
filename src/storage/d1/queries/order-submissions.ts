import { generateId, nowISO } from "../../../lib/utils";
import type { D1Client, OrderSubmissionRow } from "../client";

export type OrderSubmissionState = "RESERVED" | "SUBMITTING" | "SUBMITTED" | "FAILED";

export async function getOrderSubmissionByIdempotencyKey(
  db: D1Client,
  idempotencyKey: string
): Promise<OrderSubmissionRow | null> {
  return db.executeOne<OrderSubmissionRow>(`SELECT * FROM order_submissions WHERE idempotency_key = ?`, [
    idempotencyKey,
  ]);
}

export async function reserveOrderSubmission(
  db: D1Client,
  params: {
    idempotency_key: string;
    source: string;
    approval_id?: string | null;
    broker_provider: string;
    request_json: string;
  }
): Promise<OrderSubmissionRow> {
  const id = generateId();
  const now = nowISO();

  await db.run(
    `INSERT INTO order_submissions (id, idempotency_key, source, approval_id, broker_provider, request_json, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [
      id,
      params.idempotency_key,
      params.source,
      params.approval_id ?? null,
      params.broker_provider,
      params.request_json,
      now,
      now,
    ]
  );

  const row = await getOrderSubmissionByIdempotencyKey(db, params.idempotency_key);
  if (!row) {
    throw new Error("Failed to reserve order submission");
  }
  return row;
}

export async function setOrderSubmissionState(
  db: D1Client,
  id: string,
  state: OrderSubmissionState,
  extra: { broker_order_id?: string | null; last_error_json?: string | null; broker_provider?: string | null } = {}
): Promise<void> {
  const now = nowISO();
  await db.run(
    `UPDATE order_submissions
     SET state = ?,
         broker_order_id = COALESCE(?, broker_order_id),
         last_error_json = COALESCE(?, last_error_json),
         broker_provider = COALESCE(?, broker_provider),
         updated_at = ?
     WHERE id = ?`,
    [state, extra.broker_order_id ?? null, extra.last_error_json ?? null, extra.broker_provider ?? null, now, id]
  );
}

export async function tryTransitionOrderSubmissionState(
  db: D1Client,
  id: string,
  fromStates: OrderSubmissionState[],
  toState: OrderSubmissionState
): Promise<boolean> {
  if (fromStates.length === 0) return false;
  const now = nowISO();
  const placeholders = fromStates.map(() => "?").join(", ");
  const res = await db.run(
    `UPDATE order_submissions
     SET state = ?, updated_at = ?
     WHERE id = ? AND state IN (${placeholders})`,
    [toState, now, id, ...fromStates]
  );
  return (res.meta.changes ?? 0) > 0;
}

export async function getSubmittedOrderSubmissionsMissingTrades(
  db: D1Client,
  limit = 100
): Promise<OrderSubmissionRow[]> {
  return db.execute<OrderSubmissionRow>(
    `SELECT os.*
     FROM order_submissions os
     LEFT JOIN trades t ON t.submission_id = os.id
     WHERE os.state = 'SUBMITTED' AND t.id IS NULL
     ORDER BY os.created_at DESC
     LIMIT ?`,
    [limit]
  );
}
