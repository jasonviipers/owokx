import { generateId, hashObject, hmacSign, hmacVerify, sha256Hex } from "../lib/utils";
import type { OrderPreview, PolicyResult } from "../mcp/types";
import type { D1Client } from "../storage/d1/client";
import {
  createApproval,
  getApprovalByToken,
  getApprovalByTokenHash,
  markApprovalUsed,
  markApprovalUsedByReservation,
  releaseApprovalReservation,
  reserveApproval,
} from "../storage/d1/queries/approvals";

export interface GenerateApprovalParams {
  preview: OrderPreview;
  policyResult: PolicyResult;
  secret: string;
  db: D1Client;
  ttlSeconds: number;
}

export interface ApprovalTokenResult {
  token: string;
  approval_id: string;
  expires_at: string;
}

export async function generateApprovalToken(params: GenerateApprovalParams): Promise<ApprovalTokenResult> {
  const { preview, policyResult, secret, db, ttlSeconds } = params;

  const approvalId = generateId();
  // Bind approval token to both requested order shape and policy verdict.
  const previewHash = hashObject({ preview, policy: policyResult });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const tokenData = `${approvalId}:${previewHash}:${expiresAt}`;
  const signature = await hmacSign(tokenData, secret);
  const token = `${approvalId}.${signature}`;
  const tokenHash = await sha256Hex(token);

  await createApproval(db, {
    preview,
    policyResult,
    previewHash,
    tokenHash,
    expiresAt,
  });

  return {
    token,
    approval_id: approvalId,
    expires_at: expiresAt,
  };
}

export interface ValidateApprovalResult {
  valid: boolean;
  reason?: string;
  approval_id?: string;
  order_params?: OrderPreview;
  policy_result?: PolicyResult;
}

export async function validateApprovalToken(params: {
  token: string;
  secret: string;
  db: D1Client;
}): Promise<ValidateApprovalResult> {
  const { token, secret, db } = params;

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "Invalid token format" };
  }

  const [approvalId, signature] = parts;
  if (!approvalId || !signature) {
    return { valid: false, reason: "Invalid token format" };
  }

  const tokenHash = await sha256Hex(token);
  const approval = (await getApprovalByTokenHash(db, tokenHash)) ?? (await getApprovalByToken(db, token));
  if (!approval) {
    return { valid: false, reason: "Approval token not found" };
  }

  if (approval.used_at) {
    return { valid: false, reason: "Approval token already used" };
  }

  const now = new Date();
  const expiresAt = new Date(approval.expires_at);
  if (now > expiresAt) {
    return { valid: false, reason: "Approval token expired" };
  }

  const tokenData = `${approvalId}:${approval.preview_hash}:${approval.expires_at}`;
  const isValid = await hmacVerify(tokenData, signature, secret);
  if (!isValid) {
    return { valid: false, reason: "Invalid token signature" };
  }

  const orderParams = JSON.parse(approval.order_params_json) as OrderPreview;
  const policyResult = JSON.parse(approval.policy_result_json) as PolicyResult;

  return {
    valid: true,
    approval_id: approval.id,
    order_params: orderParams,
    policy_result: policyResult,
  };
}

export async function consumeApprovalToken(db: D1Client, approvalId: string): Promise<void> {
  await markApprovalUsed(db, approvalId);
}

export async function reserveApprovalToken(
  db: D1Client,
  approvalId: string,
  reservationId: string,
  ttlSeconds: number = 60
): Promise<boolean> {
  const reservedUntil = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return reserveApproval(db, approvalId, reservationId, reservedUntil);
}

export async function consumeReservedApprovalToken(
  db: D1Client,
  approvalId: string,
  reservationId: string
): Promise<boolean> {
  return markApprovalUsedByReservation(db, approvalId, reservationId);
}

export async function releaseReservedApprovalToken(
  db: D1Client,
  approvalId: string,
  reservationId: string,
  lastError?: unknown
): Promise<boolean> {
  const lastErrorJson = lastError
    ? JSON.stringify({
        message: String(lastError),
        at: new Date().toISOString(),
      })
    : undefined;
  return releaseApprovalReservation(db, approvalId, reservationId, lastErrorJson);
}
