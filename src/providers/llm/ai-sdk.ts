import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { generateText } from "ai";
import { createError, ErrorCode } from "../../lib/errors";
import type { CompletionParams, CompletionResult, LLMProvider } from "../types";

/**
 * Supported AI SDK providers and their environment variable mapping
 */
export const SUPPORTED_PROVIDERS = {
  openai: { envKey: "OPENAI_API_KEY", name: "OpenAI" },
  anthropic: { envKey: "ANTHROPIC_API_KEY", name: "Anthropic" },
  google: { envKey: "GOOGLE_GENERATIVE_AI_API_KEY", name: "Google" },
  xai: { envKey: "XAI_API_KEY", name: "xAI (Grok)" },
  deepseek: { envKey: "DEEPSEEK_API_KEY", name: "DeepSeek" },
} as const;

export type SupportedProvider = keyof typeof SUPPORTED_PROVIDERS;

/**
 * Popular models per provider for dashboard UI
 */
export const PROVIDER_MODELS: Record<SupportedProvider, string[]> = {
  openai: ["gpt-5.2-2025-12-11", "gpt-5", "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "gpt-3.5-turbo"],
  anthropic: ["claude-3-7-sonnet-latest", "claude-sonnet-4-0", "claude-opus-4-1", "claude-3-5-haiku-latest"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-3-pro-preview"],
  xai: ["grok-4", "grok-3", "grok-4-fast-reasoning"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
};

export interface AISDKConfig {
  /** Model identifier in format "provider/model" (e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4") */
  model: string;
  /** API keys for each provider */
  apiKeys: Partial<Record<SupportedProvider, string>>;
  /** Optional OpenAI base URL override (e.g., OpenAI-compatible proxy). */
  openaiBaseUrl?: string;
}

type ProviderFactory =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>
  | ReturnType<typeof createXai>
  | ReturnType<typeof createDeepSeek>;

function isAuthFailure(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("authentication fails") ||
    message.includes("invalid api key") ||
    message.includes("unauthorized") ||
    message.includes("http 401") ||
    message.includes("status 401")
  );
}

function isProviderConfigFailure(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("not configured") || message.includes("available:");
}

function parseModelSpec(spec: string): { provider: SupportedProvider; modelId: string } {
  const normalized = spec.trim();
  const separator = normalized.includes(":") ? ":" : "/";
  if (normalized.includes("/") || normalized.includes(":")) {
    const parts = normalized.split(separator);
    const providerCandidate = (parts[0] ?? "").toLowerCase() as SupportedProvider;
    const modelId = parts.slice(1).join(separator).trim();
    if (providerCandidate in SUPPORTED_PROVIDERS && modelId.length > 0) {
      return { provider: providerCandidate, modelId };
    }
  }

  return { provider: "openai", modelId: normalized };
}

/**
 * AI SDK Provider - Supports multiple AI providers via Vercel AI SDK
 *
 * Supports 5 providers: OpenAI, Anthropic, Google, xAI, DeepSeek
 * Model format: "provider/model" (e.g., "openai/gpt-4o", "xai/grok-4")
 */
export class AISDKProvider implements LLMProvider {
  private providers: Partial<Record<SupportedProvider, ProviderFactory>>;
  private defaultModel: string;

  constructor(config: AISDKConfig) {
    this.providers = {};

    // Initialize providers based on available API keys
    if (config.apiKeys.openai) {
      const rawBaseUrl = config.openaiBaseUrl?.trim().replace(/\/+$/, "");
      const openaiOptions: { apiKey: string; baseURL?: string } = { apiKey: config.apiKeys.openai };
      if (rawBaseUrl) {
        openaiOptions.baseURL = rawBaseUrl;
      }
      this.providers.openai = createOpenAI(openaiOptions);
    }
    if (config.apiKeys.anthropic) {
      this.providers.anthropic = createAnthropic({ apiKey: config.apiKeys.anthropic });
    }
    if (config.apiKeys.google) {
      this.providers.google = createGoogleGenerativeAI({ apiKey: config.apiKeys.google });
    }
    if (config.apiKeys.xai) {
      this.providers.xai = createXai({ apiKey: config.apiKeys.xai });
    }
    if (config.apiKeys.deepseek) {
      this.providers.deepseek = createDeepSeek({ apiKey: config.apiKeys.deepseek });
    }

    if (Object.keys(this.providers).length === 0) {
      throw createError(ErrorCode.INVALID_INPUT, "At least one provider API key is required");
    }

    this.defaultModel = config.model;
  }

  /**
   * Get list of available providers based on configured API keys
   */
  getAvailableProviders(): SupportedProvider[] {
    return Object.keys(this.providers) as SupportedProvider[];
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const startedAt = Date.now();
    let providerNameForLog = "unknown";
    let modelId = params.model ?? this.defaultModel;
    try {
      const modelSpec = params.model ?? this.defaultModel;
      const parsedModel = parseModelSpec(modelSpec);
      const providerName = parsedModel.provider;
      providerNameForLog = providerName;
      modelId = parsedModel.modelId;

      const runAttempt = async (
        selectedProvider: SupportedProvider,
        selectedModelId: string
      ): Promise<{ completion: CompletionResult; provider: SupportedProvider; model: string }> => {
        const provider = this.providers[selectedProvider];
        if (!provider) {
          const available = this.getAvailableProviders().join(", ");
          throw createError(
            ErrorCode.INVALID_INPUT,
            `Provider '${selectedProvider}' not configured. Available: ${available}`
          );
        }

        const result = await generateText({
          model: provider(selectedModelId),
          messages: params.messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: params.temperature ?? 0.7,
          maxOutputTokens: params.max_tokens ?? 1024,
        });

        return {
          provider: selectedProvider,
          model: selectedModelId,
          completion: {
            content: result.text,
            usage: {
              prompt_tokens: result.usage?.inputTokens ?? 0,
              completion_tokens: result.usage?.outputTokens ?? 0,
              total_tokens: result.usage?.totalTokens ?? 0,
            },
            provider: selectedProvider,
            model: `${selectedProvider}/${selectedModelId}`,
          },
        };
      };

      const availableProviders = this.getAvailableProviders();
      const fallbackQueue: SupportedProvider[] = [
        providerName,
        ...availableProviders.filter((provider) => provider !== providerName),
      ];
      let selectedProvider = providerName;
      let selectedModelId = modelId;
      let attempt: { completion: CompletionResult; provider: SupportedProvider; model: string } | null = null;
      let lastError: unknown = null;

      for (let i = 0; i < fallbackQueue.length; i += 1) {
        const candidateProvider = fallbackQueue[i]!;
        const candidateModel = i === 0 ? selectedModelId : (PROVIDER_MODELS[candidateProvider]?.[0] ?? selectedModelId);

        try {
          attempt = await runAttempt(candidateProvider, candidateModel);
          selectedProvider = candidateProvider;
          selectedModelId = candidateModel;
          break;
        } catch (error) {
          lastError = error;
          if (!isAuthFailure(error) && !isProviderConfigFailure(error)) {
            throw error;
          }
          if (i < fallbackQueue.length - 1) {
            const nextProvider = fallbackQueue[i + 1]!;
            const nextModel = PROVIDER_MODELS[nextProvider]?.[0] ?? selectedModelId;
            providerNameForLog = nextProvider;
            modelId = nextModel;
            try {
              console.warn(
                JSON.stringify({
                  provider: "llm",
                  engine: "ai-sdk",
                  level: "warn",
                  event: "provider_fallback",
                  from_provider: candidateProvider,
                  from_model: candidateModel,
                  to_provider: nextProvider,
                  to_model: nextModel,
                  reason: String(error),
                  timestamp: new Date().toISOString(),
                })
              );
            } catch {
              // ignore logging errors
            }
          }
        }
      }

      if (!attempt) {
        throw lastError ?? createError(ErrorCode.PROVIDER_ERROR, "No AI SDK provider succeeded");
      }

      const latencyMs = Date.now() - startedAt;
      const completion = attempt.completion;
      try {
        console.log(
          JSON.stringify({
            provider: "llm",
            engine: "ai-sdk",
            vendor: selectedProvider,
            model: selectedModelId,
            latency_ms: latencyMs,
            tokens_in: completion.usage.prompt_tokens,
            tokens_out: completion.usage.completion_tokens,
            total_tokens: completion.usage.total_tokens,
            timestamp: new Date().toISOString(),
          })
        );
      } catch {
        // ignore logging errors
      }
      return completion;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      try {
        console.error(
          JSON.stringify({
            provider: "llm",
            engine: "ai-sdk",
            level: "error",
            vendor: providerNameForLog,
            model: modelId,
            latency_ms: latencyMs,
            error: String(error),
            timestamp: new Date().toISOString(),
          })
        );
      } catch {
        // ignore logging errors
      }
      throw createError(ErrorCode.PROVIDER_ERROR, `AI SDK error: ${String(error)}`);
    }
  }
}

/** Legacy config format for backward compatibility */
export interface LegacyAISDKConfig {
  model: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

export function createAISDKProvider(config: AISDKConfig | LegacyAISDKConfig): AISDKProvider {
  // Handle legacy config format
  if ("openaiApiKey" in config || "anthropicApiKey" in config) {
    const legacyConfig = config as LegacyAISDKConfig;
    return new AISDKProvider({
      model: legacyConfig.model,
      apiKeys: {
        openai: legacyConfig.openaiApiKey,
        anthropic: legacyConfig.anthropicApiKey,
      },
    });
  }
  return new AISDKProvider(config as AISDKConfig);
}
