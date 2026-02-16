import type { Env } from "../../env.d";
import type { LLMProvider } from "../../providers/types";

export interface HarnessContext<TState = unknown> {
  env: Env;
  now: () => number;
  getState: () => TState;
  getLLM: () => LLMProvider | null;
}
