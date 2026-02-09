import { createError, ErrorCode } from "../lib/errors";
import type { OptionSnapshot, OptionsChain, OptionsProvider } from "./types";

export class NullOptionsProvider implements OptionsProvider {
  isConfigured(): boolean {
    return false;
  }

  async getExpirations(_underlying: string): Promise<string[]> {
    throw createError(ErrorCode.NOT_SUPPORTED, "Options are not supported by this broker");
  }

  async getChain(_underlying: string, _expiration: string): Promise<OptionsChain> {
    throw createError(ErrorCode.NOT_SUPPORTED, "Options are not supported by this broker");
  }

  async getSnapshot(_contractSymbol: string): Promise<OptionSnapshot> {
    throw createError(ErrorCode.NOT_SUPPORTED, "Options are not supported by this broker");
  }

  async getSnapshots(_contractSymbols: string[]): Promise<Record<string, OptionSnapshot>> {
    throw createError(ErrorCode.NOT_SUPPORTED, "Options are not supported by this broker");
  }
}

export function createNullOptionsProvider(): NullOptionsProvider {
  return new NullOptionsProvider();
}
