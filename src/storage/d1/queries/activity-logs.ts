import type { D1Client } from "../client";

export interface PersistedActivityLog {
  id: string;
  timestamp_ms: number;
  event_type: string;
  severity: string;
  status: string;
  agent: string;
  action: string;
  description: string;
  metadata_json: string;
  entry_json: string;
  searchable_text: string;
}

interface ActivityLogRow {
  entry_json: string;
}

export interface QueryActivityLogsParams {
  since?: number | null;
  until?: number | null;
  eventTypes?: string[];
  severities?: string[];
  statuses?: string[];
  agents?: string[];
  search?: string;
  limit: number;
}

function buildInClause(column: string, values: string[], queryParts: string[], params: unknown[]): void {
  if (values.length === 0) return;
  const placeholders = values.map(() => "?").join(", ");
  queryParts.push(`${column} IN (${placeholders})`);
  params.push(...values);
}

export async function insertActivityLog(db: D1Client, entry: PersistedActivityLog): Promise<void> {
  await db.run(
    `INSERT INTO agent_activity_logs (
      id,
      timestamp_ms,
      event_type,
      severity,
      status,
      agent,
      action,
      description,
      metadata_json,
      entry_json,
      searchable_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.timestamp_ms,
      entry.event_type,
      entry.severity,
      entry.status,
      entry.agent,
      entry.action,
      entry.description,
      entry.metadata_json,
      entry.entry_json,
      entry.searchable_text,
    ]
  );
}

function buildWhereClause(params: QueryActivityLogsParams): { clause: string; values: unknown[] } {
  const whereParts: string[] = [];
  const values: unknown[] = [];

  if (typeof params.since === "number") {
    whereParts.push("timestamp_ms >= ?");
    values.push(params.since);
  }
  if (typeof params.until === "number") {
    whereParts.push("timestamp_ms <= ?");
    values.push(params.until);
  }

  buildInClause("event_type", params.eventTypes ?? [], whereParts, values);
  buildInClause("severity", params.severities ?? [], whereParts, values);
  buildInClause("status", params.statuses ?? [], whereParts, values);
  buildInClause("agent", params.agents ?? [], whereParts, values);

  if (params.search && params.search.length > 0) {
    whereParts.push("searchable_text LIKE ?");
    values.push(`%${params.search.toLowerCase()}%`);
  }

  if (whereParts.length === 0) {
    return { clause: "", values };
  }
  return { clause: `WHERE ${whereParts.join(" AND ")}`, values };
}

export async function queryActivityLogs(
  db: D1Client,
  params: QueryActivityLogsParams
): Promise<{ logs: string[]; filteredCount: number; totalCount: number }> {
  const { clause, values } = buildWhereClause(params);

  const rows = await db.execute<ActivityLogRow>(
    `SELECT entry_json
     FROM agent_activity_logs
     ${clause}
     ORDER BY timestamp_ms DESC
     LIMIT ?`,
    [...values, params.limit]
  );

  const filteredCountRow = await db.executeOne<{ count: number }>(
    `SELECT COUNT(1) as count
     FROM agent_activity_logs
     ${clause}`,
    values
  );

  const totalCountRow = await db.executeOne<{ count: number }>(`SELECT COUNT(1) as count FROM agent_activity_logs`);

  return {
    logs: rows.map((row) => row.entry_json),
    filteredCount: filteredCountRow?.count ?? 0,
    totalCount: totalCountRow?.count ?? 0,
  };
}
