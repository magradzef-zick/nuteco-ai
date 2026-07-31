/**
 * Retry with backoff for any HTTP API. Nothing provider-specific: it only
 * knows whether an attempt failed and whether that's worth retrying.
 *
 * `sleep` is injected rather than calling setTimeout here, so a test can
 * assert the delay that would have been requested without waiting for it.
 */

export interface AttemptFailure {
  error: Error;
  /** Whether this specific failure is worth retrying at all. */
  retryable: boolean;
  /** Honor a server-supplied wait (a 429's retry_after) instead of guessing. */
  retryAfterMs?: number;
}

export type AttemptResult<T> = { outcome: "success"; result: T } | { outcome: "failure"; failure: AttemptFailure };

export interface RetryOptions {
  /** Total attempts, including the first -- e.g. 3 means "try once, then up to 2 retries". */
  maxAttempts: number;
  /** Base for exponential backoff when the server gave no retry_after. */
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Logging hook, called before each retry sleep. Keeps this file logger-agnostic. */
  onRetry?: (attemptNumber: number, delayMs: number, error: Error) => void;
}

/** No jitter: one process, not a fleet, so there's no thundering herd to avoid. */
export function computeBackoffMs(attemptNumber: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** (attemptNumber - 1);
}

/**
 * Calls `attempt` up to `options.maxAttempts` times. `attempt` reports its
 * own outcome rather than throwing directly, so this loop never has to
 * guess whether a given error is retryable -- the caller (which knows the
 * meaning of Telegram's HTTP status codes) decides that once, in
 * AttemptFailure.retryable.
 */
export async function callWithRetry<T>(
  attempt: (attemptNumber: number) => Promise<AttemptResult<T>>,
  options: RetryOptions
): Promise<T> {
  let lastFailure: AttemptFailure | undefined;

  for (let attemptNumber = 1; attemptNumber <= options.maxAttempts; attemptNumber++) {
    const result = await attempt(attemptNumber);

    if (result.outcome === "success") {
      return result.result;
    }

    lastFailure = result.failure;

    const isLastAttempt = attemptNumber === options.maxAttempts;
    if (!result.failure.retryable || isLastAttempt) {
      throw result.failure.error;
    }

    const delayMs = result.failure.retryAfterMs ?? computeBackoffMs(attemptNumber, options.baseDelayMs);
    options.onRetry?.(attemptNumber, delayMs, result.failure.error);
    await options.sleep(delayMs);
  }

  // Unreachable: the loop above always either returns or throws. This
  // satisfies TypeScript's control-flow analysis without a non-null
  // assertion, and would only trigger if maxAttempts <= 0.
  throw lastFailure?.error ?? new Error("callWithRetry: maxAttempts must be at least 1.");
}
