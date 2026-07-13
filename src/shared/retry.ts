/**
 * A small, deterministic retry helper for calling any external HTTP API.
 * Originally written for Telegram's Bot API (see HttpTelegramTransport.ts);
 * moved here, unchanged, so the Gemini provider (src/llm/gemini/) could
 * reuse it instead of duplicating the same retry/backoff logic a second
 * time. Nothing in this file is provider-specific -- it only knows about
 * "an attempt succeeded or failed, and if it failed, whether that's worth
 * retrying," which every HTTP-based provider needs the same way.
 *
 * The delay function (`sleep`) is always injected, never `setTimeout`
 * called directly inside the retry loop itself -- the same determinism
 * principle used throughout this project (see MessageDebouncer.ts and the
 * storage layer's explicit `now` parameters): a test can supply an instant,
 * recording fake and verify exactly what delay would have been requested,
 * without actually waiting for it.
 */

export interface AttemptFailure {
  error: Error;
  /** Whether this specific failure is worth retrying at all. */
  retryable: boolean;
  /** If Telegram told us exactly how long to wait (a 429's retry_after), honor that instead of guessing. */
  retryAfterMs?: number;
}

export type AttemptResult<T> = { outcome: "success"; result: T } | { outcome: "failure"; failure: AttemptFailure };

export interface RetryOptions {
  /** Total attempts, including the first -- e.g. 3 means "try once, then up to 2 retries". */
  maxAttempts: number;
  /** Base delay for exponential backoff when Telegram hasn't told us a specific retry_after. */
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Called right before each retry sleep -- the caller's hook for logging/observability. Retry.ts itself stays logger-agnostic and reusable. */
  onRetry?: (attemptNumber: number, delayMs: number, error: Error) => void;
}

/** Plain exponential backoff, no jitter -- deliberately simple and deterministic; this is a single process talking to Telegram, not a fleet where thundering-herd avoidance matters. */
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
