import type { Env } from "../env.d";
import { parseBoolean, parseNumber } from "../lib/utils";
import type { AlertEvent } from "./rules";

type AlertChannel = "console" | "discord" | "webhook";

interface AlertNotifierConfig {
  enabled: boolean;
  channels: AlertChannel[];
  dedupeWindowSeconds: number;
  rateLimitMaxPerWindow: number;
  rateLimitWindowSeconds: number;
  webhookUrl: string | null;
  discordWebhookUrl: string | null;
}

export interface AlertDispatchSummary {
  /**
   * Number of alert objects processed by `notify`.
   */
  attempted: number;
  /**
   * Number of successful channel sends.
   * This is channel-level, not alert-level: one alert can increment this once per enabled channel.
   */
  sent: number;
  /**
   * Number of alerts skipped because their fingerprint was already sent in the dedupe window.
   * This is alert-level.
   */
  deduped: number;
  /**
   * Number of channel attempts skipped due to rate limiting.
   * This is channel-level, not alert-level.
   */
  rate_limited: number;
  /**
   * Number of failed channel send attempts.
   * This is channel-level, not alert-level.
   */
  failed: number;
}

export interface AlertNotifier {
  notify(alerts: AlertEvent[]): Promise<AlertDispatchSummary>;
}

const ALL_CHANNELS: AlertChannel[] = ["console", "discord", "webhook"];

/**
 * Type guard that determines whether a string is a valid AlertChannel.
 *
 * @param value - The string to test
 * @returns `true` if `value` is one of `"console"`, `"discord"`, or `"webhook"`, `false` otherwise.
 */
function isAlertChannel(value: string): value is AlertChannel {
  return value === "console" || value === "discord" || value === "webhook";
}

/**
 * Parse a comma-separated string into a deduplicated list of alert channels.
 *
 * Trims whitespace, lowercases entries, validates channel names, and falls back to all channels when input is undefined or yields no valid entries.
 *
 * @param raw - Comma-separated channel names (e.g., "console,discord") or undefined to use all channels
 * @returns A deduplicated array of valid `AlertChannel` values; defaults to all supported channels when input is missing or contains no valid channels
 */
function parseChannels(raw: string | undefined): AlertChannel[] {
  if (!raw) {
    return [...ALL_CHANNELS];
  }

  const parsed = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is AlertChannel => isAlertChannel(part));

  if (parsed.length === 0) {
    return [...ALL_CHANNELS];
  }

  return Array.from(new Set(parsed));
}

/**
 * Builds an AlertNotifierConfig from environment variables, applying sensible defaults and minimum bounds.
 *
 * @param env - Environment variables used to configure the notifier.
 * @returns The constructed AlertNotifierConfig containing enabled flag, resolved channels, deduplication window, rate-limit settings, and optional webhook URLs (or `null` when not provided).
 */
function notifierConfigFromEnv(env: Env): AlertNotifierConfig {
  const channels = parseChannels(env.ALERT_CHANNELS);
  return {
    enabled: parseBoolean(env.ALERTS_ENABLED, true),
    channels,
    dedupeWindowSeconds: Math.max(60, Math.floor(parseNumber(env.ALERT_DEDUPE_WINDOW_SECONDS, 900))),
    rateLimitMaxPerWindow: Math.max(1, Math.floor(parseNumber(env.ALERT_RATE_LIMIT_MAX_PER_WINDOW, 6))),
    rateLimitWindowSeconds: Math.max(60, Math.floor(parseNumber(env.ALERT_RATE_LIMIT_WINDOW_SECONDS, 300))),
    webhookUrl:
      typeof env.ALERT_WEBHOOK_URL === "string" && env.ALERT_WEBHOOK_URL.trim().length > 0
        ? env.ALERT_WEBHOOK_URL.trim()
        : null,
    discordWebhookUrl:
      typeof env.DISCORD_WEBHOOK_URL === "string" && env.DISCORD_WEBHOOK_URL.trim().length > 0
        ? env.DISCORD_WEBHOOK_URL.trim()
        : null,
  };
}

/**
 * Returns the subset of configured channels that can actually be used given available webhook URLs.
 *
 * @param config - Notifier configuration containing the requested channels and any webhook URLs
 * @returns An array of `AlertChannel` values present in `config.channels` and usable: `discord` only if `config.discordWebhookUrl` is set, `webhook` only if `config.webhookUrl` is set, `console` always allowed
 */
function enabledChannels(config: AlertNotifierConfig): AlertChannel[] {
  return config.channels.filter((channel) => {
    if (channel === "discord") return Boolean(config.discordWebhookUrl);
    if (channel === "webhook") return Boolean(config.webhookUrl);
    return true;
  });
}

/**
 * Retrieve a value from a KV namespace by key, returning null when unavailable.
 *
 * @returns The stored string for `key`, or `null` if the `cache` is undefined, the key is missing, or an error occurs.
 */
async function kvGet(cache: KVNamespace | undefined, key: string): Promise<string | null> {
  if (!cache) return null;
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

/**
 * Writes a string value to a Workers KV namespace key with a time-to-live, performing a no-op if the KV namespace is not provided and suppressing any write errors.
 *
 * @param cache - Optional KVNamespace to write to; if undefined, the function does nothing
 * @param key - The KV key under which to store the value
 * @param value - The string value to store
 * @param ttlSeconds - Time-to-live for the key, in seconds
 */
async function kvPut(cache: KVNamespace | undefined, key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(key, value, { expirationTtl: ttlSeconds });
  } catch {
    // ignore KV failures to avoid blocking cron execution
  }
}

/**
 * Builds a namespaced KV key for alert deduplication using the provided fingerprint.
 *
 * @param fingerprint - Unique identifier for an alert (e.g., a computed hash or fingerprint)
 * @returns A namespaced key string for storing the alert's deduplication state in KV
 */
function dedupeKey(fingerprint: string): string {
  return `alerts:dedupe:${fingerprint}`;
}

/**
 * Constructs a namespaced KV key for a channel's rate-limit counter for a specific time window.
 *
 * @param channel - The alert channel (e.g., "console", "discord", "webhook")
 * @param windowStart - Numeric identifier for the time window (typically the window's start timestamp)
 * @returns The namespaced KV key string for the channel's rate-limit counter in that window
 */
function rateLimitKey(channel: AlertChannel, windowStart: number): string {
  return `alerts:ratelimit:${channel}:${windowStart}`;
}

/**
 * Determines whether a deduplication entry exists for the given fingerprint.
 *
 * @param fingerprint - The alert fingerprint used as the dedupe cache key
 * @returns `true` if an entry for `fingerprint` exists in the dedupe cache, `false` otherwise
 */
async function isDuplicate(cache: KVNamespace | undefined, fingerprint: string): Promise<boolean> {
  const existing = await kvGet(cache, dedupeKey(fingerprint));
  return existing !== null;
}

/**
 * Records an alert fingerprint in the key-value store to mark it as seen for a limited time.
 *
 * @param fingerprint - Unique fingerprint identifying the alert for deduplication
 * @param ttlSeconds - Time-to-live for the deduplication entry, in seconds
 */
async function markDuplicate(cache: KVNamespace | undefined, fingerprint: string, ttlSeconds: number): Promise<void> {
  await kvPut(cache, dedupeKey(fingerprint), String(Date.now()), ttlSeconds);
}

/**
 * Determines whether sending is permitted for a channel under the configured rate limit window.
 *
 * If the cache is unavailable or the stored counter is missing/invalid, sending is allowed.
 *
 * @param cache - KV namespace used to track per-window counters (may be `undefined`)
 * @param channel - The alert channel being checked
 * @param nowMs - Current time in milliseconds used to compute the active rate-limit window
 * @param windowSeconds - Length of the rate-limit window in seconds
 * @param maxPerWindow - Maximum allowed sends per channel within a single window
 * @returns `true` if the channel has remaining capacity in the current window, `false` otherwise.
 */
async function canSendForRateLimit(
  cache: KVNamespace | undefined,
  channel: AlertChannel,
  nowMs: number,
  windowSeconds: number,
  maxPerWindow: number
): Promise<boolean> {
  const windowStart = Math.floor(nowMs / (windowSeconds * 1000));
  const key = rateLimitKey(channel, windowStart);
  const current = await kvGet(cache, key);
  const count = current ? Number.parseInt(current, 10) : 0;
  if (!Number.isFinite(count)) return true;
  return count < maxPerWindow;
}

/**
 * Increment the per-channel rate limit counter for the current time window and set its TTL.
 *
 * @param nowMs - Current timestamp in milliseconds used to compute the window start
 * @param windowSeconds - Duration of the rate limit window in seconds
 */
async function bumpRateLimit(
  cache: KVNamespace | undefined,
  channel: AlertChannel,
  nowMs: number,
  windowSeconds: number
): Promise<void> {
  const windowStart = Math.floor(nowMs / (windowSeconds * 1000));
  const key = rateLimitKey(channel, windowStart);
  const current = await kvGet(cache, key);
  const count = current ? Number.parseInt(current, 10) : 0;
  const next = Number.isFinite(count) ? count + 1 : 1;
  await kvPut(cache, key, String(next), Math.max(windowSeconds * 2, 120));
}

/**
 * Logs an alert as a structured JSON object to the console.
 *
 * @param alert - The alert event to log
 * @returns `true` if the alert was logged to the console, `false` otherwise
 */
async function sendConsole(alert: AlertEvent): Promise<boolean> {
  console.log(
    JSON.stringify({
      provider: "alerts",
      channel: "console",
      severity: alert.severity,
      rule: alert.rule,
      title: alert.title,
      message: alert.message,
      fingerprint: alert.fingerprint,
      occurred_at: alert.occurred_at,
      details: alert.details,
    })
  );
  return true;
}

/**
 * Send an alert to a Discord webhook as a formatted embed.
 *
 * @param webhookUrl - The Discord webhook URL to post the embed to
 * @param alert - The alert event to include in the embed (title, message, severity, rule, fingerprint, occurred_at)
 * @returns `true` if the HTTP response has a successful status (`response.ok`), `false` otherwise
 */
async function sendDiscord(webhookUrl: string, alert: AlertEvent): Promise<boolean> {
  const color = alert.severity === "critical" ? 0xef4444 : alert.severity === "warning" ? 0xf59e0b : 0x2563eb;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: `[${alert.severity.toUpperCase()}] ${alert.title}`,
          description: alert.message,
          color,
          timestamp: alert.occurred_at,
          fields: [
            { name: "Rule", value: alert.rule, inline: true },
            { name: "Fingerprint", value: alert.fingerprint.slice(0, 128), inline: false },
          ],
        },
      ],
    }),
  });

  return response.ok;
}

/**
 * Send an alert to a generic HTTP webhook endpoint.
 *
 * Posts a JSON payload with `type: "owokx.alert"` and the provided `alert` object.
 *
 * @param webhookUrl - Destination webhook URL
 * @param alert - The alert event to include in the webhook payload
 * @returns `true` if the HTTP response status is OK (2xx), `false` otherwise
 */
async function sendWebhook(webhookUrl: string, alert: AlertEvent): Promise<boolean> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "owokx.alert",
      alert,
    }),
  });
  return response.ok;
}

/**
 * Dispatches a single alert to the specified channel.
 *
 * Attempts to send the alert to the selected channel; for "discord" and "webhook" channels the corresponding webhook URL from the config must be present or the send will be skipped.
 *
 * @param config - Notifier configuration used to locate webhook URLs and other settings
 * @param channel - Target channel to send the alert to ("console", "discord", or "webhook")
 * @param alert - The alert event to dispatch
 * @returns `true` if the alert was successfully sent to the target channel, `false` otherwise
 */
async function sendViaChannel(config: AlertNotifierConfig, channel: AlertChannel, alert: AlertEvent): Promise<boolean> {
  if (channel === "console") return sendConsole(alert);
  if (channel === "discord") {
    if (!config.discordWebhookUrl) return false;
    return sendDiscord(config.discordWebhookUrl, alert);
  }
  if (channel === "webhook") {
    if (!config.webhookUrl) return false;
    return sendWebhook(config.webhookUrl, alert);
  }
  return false;
}

/**
 * Creates an AlertNotifier configured from the provided environment.
 *
 * The returned notifier's `notify` method dispatches each alert to the enabled channels determined from `env`, skips alerts already seen within the dedupe window, enforces per-channel rate limits, marks successfully delivered alerts for future deduplication, and returns an AlertDispatchSummary with counts of attempted, sent, deduped, rate-limited, and failed deliveries.
 *
 * @returns An AlertNotifier that dispatches alerts across enabled channels and produces an AlertDispatchSummary describing delivery outcomes
 */
export function createAlertNotifier(env: Env): AlertNotifier {
  const config = notifierConfigFromEnv(env);
  const channels = enabledChannels(config);

  return {
    async notify(alerts: AlertEvent[]): Promise<AlertDispatchSummary> {
      const summary: AlertDispatchSummary = {
        attempted: alerts.length,
        sent: 0,
        deduped: 0,
        rate_limited: 0,
        failed: 0,
      };

      if (!config.enabled || alerts.length === 0 || channels.length === 0) {
        return summary;
      }

      for (const alert of alerts) {
        const duplicate = await isDuplicate(env.CACHE, alert.fingerprint);
        if (duplicate) {
          summary.deduped += 1;
          continue;
        }

        let sentForAlert = false;

        // Intentionally fan out each alert to all enabled channels via sendViaChannel.
        // `sent`, `rate_limited`, and `failed` are channel-attempt counters (not per-alert counters).
        for (const channel of channels) {
          const nowMs = Date.now();
          const canSend = await canSendForRateLimit(
            env.CACHE,
            channel,
            nowMs,
            config.rateLimitWindowSeconds,
            config.rateLimitMaxPerWindow
          );
          if (!canSend) {
            summary.rate_limited += 1;
            continue;
          }

          try {
            const ok = await sendViaChannel(config, channel, alert);
            if (ok) {
              summary.sent += 1;
              sentForAlert = true;
              await bumpRateLimit(env.CACHE, channel, nowMs, config.rateLimitWindowSeconds);
            } else {
              summary.failed += 1;
            }
          } catch (error) {
            summary.failed += 1;
            console.error("[alerts] channel_send_failed", {
              channel,
              rule: alert.rule,
              fingerprint: alert.fingerprint,
              error: String(error),
            });
          }
        }

        // Deduplication is alert-level and only applied after at least one channel accepted the alert.
        if (sentForAlert) {
          await markDuplicate(env.CACHE, alert.fingerprint, config.dedupeWindowSeconds);
        }
      }

      return summary;
    },
  };
}