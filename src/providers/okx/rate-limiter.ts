function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedRetryError {
  code?: string;
  httpStatus?: number;
  message: string;
  retryAfterMs?: number;
}

function parseRetryError(error: unknown): ParsedRetryError {
  const fallback: ParsedRetryError = {
    message: String(error ?? "unknown error"),
  };

  if (!error || typeof error !== "object") {
    return fallback;
  }

  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : fallback.message;
  const code = typeof record.code === "string" ? record.code : undefined;

  const response =
    typeof record.response === "object" && record.response ? (record.response as Record<string, unknown>) : undefined;
  const httpStatus = typeof response?.status === "number" ? response.status : undefined;

  let retryAfterMs: number | undefined;
  const headers =
    typeof response?.headers === "object" && response.headers
      ? (response.headers as Record<string, unknown>)
      : undefined;
  const retryAfterRaw = headers?.["retry-after"];
  if (typeof retryAfterRaw === "string") {
    const retryAfterSeconds = Number(retryAfterRaw);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      retryAfterMs = retryAfterSeconds * 1000;
    }
  }

  return {
    code,
    httpStatus,
    message,
    retryAfterMs,
  };
}

export class RateLimiter {
  private readonly requests: number[] = [];
  private readonly intervalMs = 1000;

  constructor(private readonly maxRequestsPerSecond: number = 10) {}

  private prune(now: number): void {
    const windowStart = now - this.intervalMs;
    while (this.requests.length > 0) {
      const firstRequest = this.requests[0];
      if (firstRequest === undefined || firstRequest > windowStart) {
        break;
      }
      this.requests.shift();
    }
  }

  private getWaitTime(now: number): number {
    this.prune(now);

    if (this.requests.length < this.maxRequestsPerSecond) {
      return 0;
    }

    const oldestRequest = this.requests[0];
    if (oldestRequest === undefined) {
      return 0;
    }

    return Math.max(0, this.intervalMs - (now - oldestRequest));
  }

  async waitForSlot(): Promise<void> {
    while (true) {
      const now = Date.now();
      const waitTime = this.getWaitTime(now);

      if (waitTime <= 0) {
        this.requests.push(Date.now());
        return;
      }

      await sleep(waitTime);
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForSlot();
    return fn();
  }

  getRemainingCapacity(): number {
    this.prune(Date.now());
    return Math.max(0, this.maxRequestsPerSecond - this.requests.length);
  }
}

export class RetryWithBackoff {
  constructor(
    private readonly maxRetries: number = 3,
    private readonly baseDelayMs: number = 250,
    private readonly maxDelayMs: number = 5000
  ) {}

  private shouldRetry(error: ParsedRetryError): boolean {
    if (error.httpStatus && [429, 500, 502, 503, 504].includes(error.httpStatus)) {
      return true;
    }

    if (error.code && ["50011", "50040", "429"].includes(error.code)) {
      return true;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("socket") ||
      message.includes("temporarily unavailable") ||
      message.includes("too many requests")
    );
  }

  private getDelayMs(attempt: number, parsedError: ParsedRetryError): number {
    if (parsedError.retryAfterMs && parsedError.retryAfterMs > 0) {
      return Math.min(parsedError.retryAfterMs, this.maxDelayMs);
    }

    const exponential = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    const jitter = Math.floor(Math.random() * Math.max(25, this.baseDelayMs));
    return exponential + jitter;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const parsedError = parseRetryError(error);

        if (attempt >= this.maxRetries || !this.shouldRetry(parsedError)) {
          throw error;
        }

        const delayMs = this.getDelayMs(attempt, parsedError);
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error("Retry handler failed without a captured error");
  }
}

export class OkxRateLimitedClient {
  private readonly rateLimiter: RateLimiter;
  private readonly retryHandler: RetryWithBackoff;

  constructor(maxRequestsPerSecond: number = 10, maxRetries: number = 3) {
    this.rateLimiter = new RateLimiter(maxRequestsPerSecond);
    this.retryHandler = new RetryWithBackoff(maxRetries);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.retryHandler.execute(() => this.rateLimiter.execute(fn));
  }

  getRemainingCapacity(): number {
    return this.rateLimiter.getRemainingCapacity();
  }
}
