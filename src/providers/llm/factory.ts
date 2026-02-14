import type { Env } from "../../env.d";
import type { LLMProvider } from "../types";
import { createAISDKProvider, PROVIDER_MODELS, SUPPORTED_PROVIDERS, type SupportedProvider } from "./ai-sdk";
import { createCloudflareGatewayProvider } from "./cloudflare-gateway";
import { createOpenAIProvider } from "./openai";

export type LLMProviderType = "openai-raw" | "ai-sdk" | "cloudflare-gateway";

function normalizeString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProviderType(value: string | undefined): LLMProviderType {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "openai-raw" || normalized === "ai-sdk" || normalized === "cloudflare-gateway") {
    return normalized;
  }
  return "openai-raw";
}

function parseModelProvider(model: string): SupportedProvider {
  const normalized = model.trim();
  if (normalized.includes("/")) {
    const [provider] = normalized.split("/", 2);
    const key = provider?.toLowerCase() as SupportedProvider | undefined;
    if (key && key in SUPPORTED_PROVIDERS) {
      return key;
    }
  }
  if (normalized.includes(":")) {
    const [provider] = normalized.split(":", 2);
    const key = provider?.toLowerCase() as SupportedProvider | undefined;
    if (key && key in SUPPORTED_PROVIDERS) {
      return key;
    }
  }
  return "openai";
}

function collectApiKeys(env: Env): Partial<Record<SupportedProvider, string>> {
  const keys: Partial<Record<SupportedProvider, string>> = {};
  const openai = normalizeString(env.OPENAI_API_KEY);
  const anthropic = normalizeString(env.ANTHROPIC_API_KEY);
  const google = normalizeString(env.GOOGLE_GENERATIVE_AI_API_KEY);
  const xai = normalizeString(env.XAI_API_KEY);
  const deepseek = normalizeString(env.DEEPSEEK_API_KEY);

  if (openai) keys.openai = openai;
  if (anthropic) keys.anthropic = anthropic;
  if (google) keys.google = google;
  if (xai) keys.xai = xai;
  if (deepseek) keys.deepseek = deepseek;
  return keys;
}

function resolveAiSdkModel(
  requestedModel: string,
  apiKeys: Partial<Record<SupportedProvider, string>>
): { model: string; fallbackFrom?: string } | null {
  const availableProviders = (Object.keys(apiKeys) as SupportedProvider[]).filter((provider) => !!apiKeys[provider]);
  if (availableProviders.length === 0) return null;

  const normalizedRequested = requestedModel.trim();
  const requestedProvider = parseModelProvider(normalizedRequested);

  if (apiKeys[requestedProvider]) {
    if (normalizedRequested.includes("/") || normalizedRequested.includes(":")) {
      return { model: normalizedRequested.replace(":", "/") };
    }
    return { model: `${requestedProvider}/${normalizedRequested}` };
  }

  const fallbackProvider = availableProviders[0]!;
  const fallbackModel = PROVIDER_MODELS[fallbackProvider]?.[0] ?? normalizedRequested;
  return {
    model: `${fallbackProvider}/${fallbackModel}`,
    fallbackFrom: normalizedRequested,
  };
}

/**
 * Factory function to create LLM provider based on environment configuration.
 *
 * Provider selection (via LLM_PROVIDER env):
 * - "openai-raw": Direct OpenAI API calls (default, backward compatible)
 * - "ai-sdk": Vercel AI SDK with 5 providers (OpenAI, Anthropic, Google, xAI, DeepSeek)
 * - "cloudflare-gateway": Cloudflare AI Gateway (/compat) for unified access
 *
 * @param env - Environment variables
 * @returns LLMProvider instance or null if no valid configuration
 */
export function createLLMProvider(env: Env): LLMProvider | null {
  const providerType = normalizeProviderType(env.LLM_PROVIDER);
  const model = normalizeString(env.LLM_MODEL) ?? "gpt-4o-mini";
  const openaiBaseUrlRaw = normalizeString(env.OPENAI_BASE_URL)?.replace(/\/+$/, "");
  const openaiBaseUrl = openaiBaseUrlRaw ? openaiBaseUrlRaw : undefined;
  const apiKeys = collectApiKeys(env);

  const createAiSdk = (): LLMProvider | null => {
    const resolved = resolveAiSdkModel(model, apiKeys);
    if (!resolved) {
      console.warn("LLM_PROVIDER=ai-sdk requires at least one provider API key");
      return null;
    }
    if (resolved.fallbackFrom) {
      console.warn(
        `LLM model '${resolved.fallbackFrom}' is not configured; falling back to '${resolved.model}' based on available API keys.`
      );
    }
    return createAISDKProvider({ model: resolved.model, apiKeys, openaiBaseUrl });
  };

  const createOpenAi = (): LLMProvider | null => {
    const openaiKey = apiKeys.openai;
    if (!openaiKey) return null;

    if (model.includes("/")) {
      const [modelProvider, modelName] = model.split("/", 2);
      if (modelProvider && modelProvider.toLowerCase() !== "openai") {
        console.warn(
          `LLM_MODEL='${model}' is not compatible with LLM_PROVIDER=openai-raw. Falling back to AI SDK when available.`
        );
        return null;
      }
      return createOpenAIProvider({
        apiKey: openaiKey,
        model: modelName ?? "gpt-4o-mini",
        baseUrl: openaiBaseUrl,
      });
    }

    if (model.includes(":")) {
      const [modelProvider, modelName] = model.split(":", 2);
      if (modelProvider && modelProvider.toLowerCase() !== "openai") {
        console.warn(
          `LLM_MODEL='${model}' is not compatible with LLM_PROVIDER=openai-raw. Falling back to AI SDK when available.`
        );
        return null;
      }
      return createOpenAIProvider({
        apiKey: openaiKey,
        model: modelName ?? "gpt-4o-mini",
        baseUrl: openaiBaseUrl,
      });
    }

    return createOpenAIProvider({
      apiKey: openaiKey,
      model,
      baseUrl: openaiBaseUrl,
    });
  };

  const createCloudflareGateway = (): LLMProvider | null => {
    const accountId = normalizeString(env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID);
    const gatewayId = normalizeString(env.CLOUDFLARE_AI_GATEWAY_ID);
    const token = normalizeString(env.CLOUDFLARE_AI_GATEWAY_TOKEN);
    if (!accountId || !gatewayId || !token) {
      console.warn(
        "LLM_PROVIDER=cloudflare-gateway requires CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY_ID, and CLOUDFLARE_AI_GATEWAY_TOKEN"
      );
      return null;
    }
    const effectiveModel = model.includes("/") ? model : `openai/${model}`;
    return createCloudflareGatewayProvider({
      accountId,
      gatewayId,
      token,
      model: effectiveModel,
    });
  };

  const fallbackOrder: LLMProviderType[] =
    providerType === "cloudflare-gateway"
      ? ["cloudflare-gateway", "ai-sdk", "openai-raw"]
      : providerType === "ai-sdk"
        ? ["ai-sdk", "cloudflare-gateway", "openai-raw"]
        : ["openai-raw", "ai-sdk", "cloudflare-gateway"];

  for (const candidate of fallbackOrder) {
    const provider =
      candidate === "ai-sdk"
        ? createAiSdk()
        : candidate === "cloudflare-gateway"
          ? createCloudflareGateway()
          : createOpenAi();
    if (provider) {
      if (candidate !== providerType) {
        console.warn(`LLM provider fallback: requested '${providerType}', using '${candidate}'.`);
      }
      return provider;
    }
  }

  return null;
}

/**
 * Check if LLM features are available based on environment configuration.
 */
export function isLLMConfigured(env: Env): boolean {
  const providerType = normalizeProviderType(env.LLM_PROVIDER);
  const keys = collectApiKeys(env);

  switch (providerType) {
    case "cloudflare-gateway":
      return !!(
        normalizeString(env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID) &&
        normalizeString(env.CLOUDFLARE_AI_GATEWAY_ID) &&
        normalizeString(env.CLOUDFLARE_AI_GATEWAY_TOKEN)
      );
    case "ai-sdk":
      return Object.keys(keys).length > 0;
    default:
      return !!keys.openai;
  }
}

/**
 * Get list of configured providers based on available API keys
 */
export function getConfiguredProviders(env: Env): SupportedProvider[] {
  const configured: SupportedProvider[] = [];
  const keys = collectApiKeys(env);
  if (keys.openai) configured.push("openai");
  if (keys.anthropic) configured.push("anthropic");
  if (keys.google) configured.push("google");
  if (keys.xai) configured.push("xai");
  if (keys.deepseek) configured.push("deepseek");
  return configured;
}
