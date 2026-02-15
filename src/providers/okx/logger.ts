export type OkxLogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVEL_ORDER: Record<OkxLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  if (error && typeof error === "object") {
    return error as Record<string, unknown>;
  }

  return { value: String(error) };
}

export interface OkxLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
}

export function createOkxLogger(scope: string, level: OkxLogLevel = "info"): OkxLogger {
  const threshold = LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info;

  const write = (targetLevel: OkxLogLevel, message: string, context?: Record<string, unknown>) => {
    if (LOG_LEVEL_ORDER[targetLevel] < threshold) {
      return;
    }

    const payload = context ? ` ${JSON.stringify(context)}` : "";
    const prefix = `[okx:${scope}]`;

    if (targetLevel === "error") {
      console.error(`${prefix} ${message}${payload}`);
      return;
    }

    if (targetLevel === "warn") {
      console.warn(`${prefix} ${message}${payload}`);
      return;
    }

    if (targetLevel === "info") {
      console.info(`${prefix} ${message}${payload}`);
      return;
    }

    console.debug(`${prefix} ${message}${payload}`);
  };

  return {
    debug(message, context) {
      write("debug", message, context);
    },
    info(message, context) {
      write("info", message, context);
    },
    warn(message, context) {
      write("warn", message, context);
    },
    error(message, error, context) {
      write("error", message, {
        ...context,
        error: normalizeError(error),
      });
    },
  };
}
