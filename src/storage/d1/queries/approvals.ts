import { generateId, nowISO } from "../../../lib/utils";
import type { OrderPreview, PolicyResult } from "../../../mcp/types";
import type { D1Client, OrderApprovalRow } from "../client";

export interface CreateApprovalParams {
  preview: OrderPreview;
  policyResult: PolicyResult;
  previewHash: string;
  tokenHash: string;
  expiresAt: string;
}

export async function createApproval(db: D1Client, params: CreateApprovalParams): Promise<string> {
  const id = generateId();

  await db.run(
    `INSERT INTO order_approvals (id, preview_hash, order_params_json, policy_result_json, approval_token, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.previewHash,
      JSON.stringify(params.preview),
      JSON.stringify(params.policyResult),
      params.tokenHash,
      params.tokenHash,
      params.expiresAt,
      nowISO(),
    ]
  );

  return id;
}

export async function getApprovalByTokenHash(db: D1Client, tokenHash: string): Promise<OrderApprovalRow | null> {
  return db.executeOne<OrderApprovalRow>(`SELECT * FROM order_approvals WHERE token_hash = ?`, [tokenHash]);
}

export async function getApprovalByToken(db: D1Client, token: string): Promise<OrderApprovalRow | null> {
  return db.executeOne<OrderApprovalRow>(`SELECT * FROM order_approvals WHERE approval_token = ?`, [token]);
}

export async function markApprovalUsed(db: D1Client, approvalId: string): Promise<void> {
  const now = nowISO();
  await db.run(
    `UPDATE order_approvals
     SET used_at = ?,
         state = 'USED',
         reserved_at = NULL,
         reserved_by = NULL,
         reserved_until = NULL
     WHERE id = ?`,
    [now, approvalId]
  );
}

export async function reserveApproval(
  db: D1Client,
  approvalId: string,
  reservedBy: string,
  reservedUntil: string
): Promise<boolean> {
  const now = nowISO();
  const result = await db.run(
    `UPDATE order_approvals
     SET state = 'RESERVED',
         reserved_at = ?,
         reserved_by = ?,
         reserved_until = ?,
         failed_at = NULL,
         last_error_json = NULL
     WHERE id = ?
       AND used_at IS NULL
       AND expires_at > ?
       AND (state = 'ACTIVE' OR state IS NULL OR (state = 'RESERVED' AND reserved_until < ?))`,
    [now, reservedBy, reservedUntil, approvalId, now, now]
  );
  return (result.meta.changes ?? 0) > 0;
}

export async function markApprovalUsedByReservation(
  db: D1Client,
  approvalId: string,
  reservedBy: string
): Promise<boolean> {
  const now = nowISO();
  const result = await db.run(
    `UPDATE order_approvals
     SET used_at = ?,
         submitted_at = ?,
         state = 'USED',
         reserved_at = NULL,
         reserved_by = NULL,
         reserved_until = NULL
     WHERE id = ?
       AND used_at IS NULL
       AND state = 'RESERVED'
       AND reserved_by = ?`,
    [now, now, approvalId, reservedBy]
  );
  return (result.meta.changes ?? 0) > 0;
}

export async function releaseApprovalReservation(
  db: D1Client,
  approvalId: string,
  reservedBy: string,
  lastErrorJson?: string
): Promise<boolean> {
  const now = nowISO();
  const result = await db.run(
    `UPDATE order_approvals
     SET state = 'ACTIVE',
         reserved_at = NULL,
         reserved_by = NULL,
         reserved_until = NULL,
         failed_at = ?,
         last_error_json = COALESCE(?, last_error_json)
     WHERE id = ?
       AND used_at IS NULL
       AND state = 'RESERVED'
       AND reserved_by = ?`,
    [now, lastErrorJson ?? null, approvalId, reservedBy]
  );
  return (result.meta.changes ?? 0) > 0;
}

export async function cleanupExpiredApprovals(db: D1Client): Promise<number> {
  const result = await db.run(`DELETE FROM order_approvals WHERE expires_at < ? AND used_at IS NULL`, [nowISO()]);
  return result.meta.changes ?? 0;
}

export async function getRecentApprovals(db: D1Client, limit: number = 20): Promise<OrderApprovalRow[]> {
  return db.execute<OrderApprovalRow>(`SELECT * FROM order_approvals ORDER BY created_at DESC LIMIT ?`, [limit]);
}
