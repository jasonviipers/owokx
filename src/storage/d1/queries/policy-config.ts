import { nowISO } from "../../../lib/utils";
import {
  getSafePolicyFallbackConfig,
  mergePolicyConfigWithDefaults,
  type PolicyConfig,
  validatePolicyConfig,
} from "../../../policy/config";
import type { D1Client, PolicyConfigRow } from "../client";

export async function getPolicyConfig(db: D1Client): Promise<PolicyConfig | null> {
  const row = await db.executeOne<PolicyConfigRow>(`SELECT * FROM policy_config WHERE id = 1`);

  if (!row) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.config_json) as Partial<PolicyConfig>;
    const merged = mergePolicyConfigWithDefaults(parsed);
    validatePolicyConfig(merged);
    return merged;
  } catch {
    const fallback = getSafePolicyFallbackConfig();
    return fallback;
  }
}

export async function savePolicyConfig(db: D1Client, config: PolicyConfig): Promise<void> {
  const configJson = JSON.stringify(config);

  await db.run(
    `INSERT INTO policy_config (id, config_json, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
    [configJson, nowISO()]
  );
}
