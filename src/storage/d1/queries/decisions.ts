import { generateId, hashObject, nowISO } from "../../../lib/utils";
import type { D1Client } from "../client";

export interface CreateDecisionParams {
  source: string;
  kind: string;
  model: string;
  temperature: number;
  input: unknown;
  output: unknown;
}

export async function createDecision(db: D1Client, params: CreateDecisionParams): Promise<string> {
  const id = generateId();
  const createdAt = nowISO();
  const inputJson = JSON.stringify(params.input);
  const outputJson = JSON.stringify(params.output);
  const inputHash = hashObject({ inputJson, model: params.model, temperature: params.temperature, kind: params.kind });

  await db.run(
    `INSERT INTO agent_decisions (id, source, kind, model, temperature, input_hash, input_json, output_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.source, params.kind, params.model, params.temperature, inputHash, inputJson, outputJson, createdAt]
  );

  return id;
}
