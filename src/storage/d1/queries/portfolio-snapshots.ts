import type { D1Client } from "../client";

interface PortfolioSnapshotRow {
  timestamp_ms: number;
  equity: number;
}

export async function insertPortfolioSnapshot(db: D1Client, timestampMs: number, equity: number): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO portfolio_snapshots (timestamp_ms, equity)
     VALUES (?, ?)`,
    [timestampMs, equity]
  );
}

export async function queryPortfolioSnapshots(
  db: D1Client,
  params: { since?: number | null; until?: number | null; limit?: number }
): Promise<Array<{ timestamp_ms: number; equity: number }>> {
  const where: string[] = [];
  const values: unknown[] = [];

  if (typeof params.since === "number") {
    where.push("timestamp_ms >= ?");
    values.push(params.since);
  }
  if (typeof params.until === "number") {
    where.push("timestamp_ms <= ?");
    values.push(params.until);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : 5000;

  const rows = await db.execute<PortfolioSnapshotRow>(
    `SELECT timestamp_ms, equity
     FROM portfolio_snapshots
     ${whereClause}
     ORDER BY timestamp_ms DESC
     LIMIT ?`,
    [...values, limit]
  );

  return rows.reverse();
}
