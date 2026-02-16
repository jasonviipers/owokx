import type { HarnessContext } from "./types";

export interface ResearchService<TResult = unknown> {
  researchTopSignals: (limit?: number) => Promise<TResult[]>;
}

export interface ResearchServiceDelegates<TResult = unknown> {
  researchTopSignals: (limit?: number) => Promise<TResult[]>;
}

class DefaultResearchService<TResult> implements ResearchService<TResult> {
  constructor(
    _context: HarnessContext,
    private readonly delegates: ResearchServiceDelegates<TResult>
  ) {}

  async researchTopSignals(limit?: number): Promise<TResult[]> {
    return this.delegates.researchTopSignals(limit);
  }
}

export function createResearchService<TResult>(
  context: HarnessContext,
  delegates: ResearchServiceDelegates<TResult>
): ResearchService<TResult> {
  return new DefaultResearchService<TResult>(context, delegates);
}
