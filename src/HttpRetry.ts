import axios from "axios";
import { TimeoutWait, TIMEOUT_MAX_DURATION_MS } from "./Timeout";

/**
 * Bounded retry for outbound HTTP calls.
 *
 * Retries only transient failures: network/timeout errors (no response),
 * HTTP 429 and 5xx responses. Other 4xx failures are not retried. The
 * default is disabled (`maxAttempts: 1`), because retrying a non-idempotent
 * POST (for example an LLM completion) can duplicate work and billing.
 */
export interface HttpRetryOptions {
  /** Total attempts including the first. Default 1 (no retry), capped at 10. */
  maxAttempts?: number;
  /** Base delay in milliseconds. Default 250. */
  baseDelayMs?: number;
  /** Upper bound for a single delay in milliseconds. Default 10000. */
  maxDelayMs?: number;
}

/** Options after validation and defaulting. */
export interface NormalizedHttpRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const HTTP_RETRY_MAX_ATTEMPTS = 10;
const HTTP_RETRY_DEFAULT_BASE_DELAY_MS = 250;
const HTTP_RETRY_DEFAULT_MAX_DELAY_MS = 10000;

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

/** Validate and clamp retry options; invalid values fall back to defaults. */
export function HttpRetryNormalizeOptions(
  options?: HttpRetryOptions,
): NormalizedHttpRetryOptions {
  const requestedAttempts = options?.maxAttempts;
  const maxAttempts =
    requestedAttempts !== undefined &&
    Number.isFinite(requestedAttempts) &&
    requestedAttempts >= 1
      ? Math.min(Math.floor(requestedAttempts), HTTP_RETRY_MAX_ATTEMPTS)
      : 1;
  const baseDelayMs = nonNegativeInt(
    options?.baseDelayMs,
    HTTP_RETRY_DEFAULT_BASE_DELAY_MS,
  );
  const maxDelayMs = Math.min(
    TIMEOUT_MAX_DURATION_MS,
    Math.max(
      baseDelayMs,
      nonNegativeInt(options?.maxDelayMs, HTTP_RETRY_DEFAULT_MAX_DELAY_MS),
    ),
  );
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

/**
 * Whether an error is worth retrying: a network/timeout failure (Axios error
 * without a response), HTTP 429 or a 5xx response.
 */
export function HttpRetryIsRetryable(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  if (!error.response) {
    return true;
  }
  const status = error.response.status;
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Run `operation`, retrying retryable failures with exponential backoff and
 * full jitter (`random(0, min(maxDelayMs, baseDelayMs * 2^(attempt-1)))`).
 *
 * @param onRetry  Invoked before each wait, for attempt logging.
 */
export async function HttpRetry<T>(
  operation: () => Promise<T>,
  options?: HttpRetryOptions,
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } =
    HttpRetryNormalizeOptions(options);
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !HttpRetryIsRetryable(error)) {
        throw error;
      }
      const ceiling = Math.min(
        maxDelayMs,
        baseDelayMs * 2 ** (attempt - 1),
      );
      const delayMs = Math.round(Math.random() * ceiling);
      onRetry?.(attempt, delayMs, error);
      await TimeoutWait(delayMs);
      attempt++;
    }
  }
}
