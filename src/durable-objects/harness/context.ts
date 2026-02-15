import type { Env } from "../../env.d";
import type { LLMProvider } from "../../providers/types";
import type { HarnessContext } from "./types";

export interface CreateHarnessContextParams<TState> {
  env: Env;
  getState: () => TState;
  getLLM: () => LLMProvider | null;
  now?: () => number;
}

export function createHarnessContext<TState>(params: CreateHarnessContextParams<TState>): HarnessContext<TState> {
  return {
    env: params.env,
    now: params.now ?? (() => Date.now()),
    getState: params.getState,
    getLLM: params.getLLM,
  };
}
