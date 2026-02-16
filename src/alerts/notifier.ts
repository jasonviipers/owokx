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

function isAlertChannel(value: string): value is AlertChannel {
  return value === "console" || value === "discord" || value === "webhook";
}

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

function enabledChannels(config: AlertNotifierConfig): AlertChannel[] {
  return config.channels.filter((channel) => {
    if (channel === "discord") return Boolean(config.discordWebhookUrl);
    if (channel === "webhook") return Boolean(config.webhookUrl);
    return true;
  });
}

async function kvGet(cache: KVNamespace | undefined, key: string): Promise<string | null> {
  if (!cache) return null;
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

async function kvPut(cache: KVNamespace | undefined, key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(key, value, { expirationTtl: ttlSeconds });
  } catch {
    // ignore KV failures to avoid blocking cron execution
  }
}

function dedupeKey(fingerprint: string): string {
  return `alerts:dedupe:${fingerprint}`;
}

function rateLimitKey(channel: AlertChannel, windowStart: number): string {
  return `alerts:ratelimit:${channel}:${windowStart}`;
}

async function isDuplicate(cache: KVNamespace | undefined, fingerprint: string): Promise<boolean> {
  const existing = await kvGet(cache, dedupeKey(fingerprint));
  return existing !== null;
}

async function markDuplicate(cache: KVNamespace | undefined, fingerprint: string, ttlSeconds: number): Promise<void> {
  await kvPut(cache, dedupeKey(fingerprint), String(Date.now()), ttlSeconds);
}

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
