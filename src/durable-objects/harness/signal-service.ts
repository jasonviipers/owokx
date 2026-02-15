import type { HarnessContext } from "./types";

export interface SignalService {
  runDataGatherers: () => Promise<void>;
}

export interface SignalServiceDelegates {
  runDataGatherers: () => Promise<void>;
}

class DefaultSignalService implements SignalService {
  constructor(
    _context: HarnessContext,
    private readonly delegates: SignalServiceDelegates
  ) {}

  async runDataGatherers(): Promise<void> {
    await this.delegates.runDataGatherers();
  }
}

export function createSignalService(context: HarnessContext, delegates: SignalServiceDelegates): SignalService {
  return new DefaultSignalService(context, delegates);
}
