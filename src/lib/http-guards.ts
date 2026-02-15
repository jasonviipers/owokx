export interface AgentMethodValidationResult {
  ok: boolean;
  isMutation: boolean;
  allowed?: string[];
}

const postOnlyPaths = new Set(["/enable", "/disable", "/trigger", "/reset", "/kill"]);

export function validateAgentMethod(agentPath: string, method: string): AgentMethodValidationResult {
  const upperMethod = method.toUpperCase();
  if (postOnlyPaths.has(agentPath) && upperMethod !== "POST") {
    return { ok: false, isMutation: true, allowed: ["POST"] };
  }
  if (agentPath === "/config" && upperMethod !== "GET" && upperMethod !== "POST") {
    return { ok: false, isMutation: false, allowed: ["GET", "POST"] };
  }
  return {
    ok: true,
    isMutation: postOnlyPaths.has(agentPath) || (agentPath === "/config" && upperMethod === "POST"),
  };
}
