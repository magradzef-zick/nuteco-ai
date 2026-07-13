import { test } from "node:test";
import assert from "node:assert/strict";
import { callWithRetry, computeBackoffMs, type AttemptResult } from "../src/shared/retry";

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
      // no real waiting -- this is what keeps the test instant
    },
  };
}

test("returns the result immediately on first success, without sleeping", async () => {
  const { sleep, delays } = recordingSleep();
  let attempts = 0;

  const result = await callWithRetry<string>(
    async () => {
      attempts++;
      return { outcome: "success", result: "ok" };
    },
    { maxAttempts: 3, baseDelayMs: 100, sleep }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("retries a retryable failure and succeeds on a later attempt", async () => {
  const { sleep, delays } = recordingSleep();
  let attempts = 0;

  const result = await callWithRetry<string>(
    async () => {
      attempts++;
      if (attempts < 3) {
        return { outcome: "failure", failure: { error: new Error("temporary"), retryable: true } };
      }
      return { outcome: "success", result: "ok" };
    },
    { maxAttempts: 5, baseDelayMs: 100, sleep }
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200], "backoff should double each retry");
});

test("throws immediately on a non-retryable failure, without retrying", async () => {
  const { sleep, delays } = recordingSleep();
  let attempts = 0;
  const nonRetryableError = new Error("bad request");

  await assert.rejects(
    () =>
      callWithRetry<string>(
        async () => {
          attempts++;
          return { outcome: "failure", failure: { error: nonRetryableError, retryable: false } };
        },
        { maxAttempts: 5, baseDelayMs: 100, sleep }
      ),
    nonRetryableError
  );

  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("gives up after maxAttempts and throws the last failure", async () => {
  const { sleep } = recordingSleep();
  let attempts = 0;
  const alwaysFails = async (): Promise<AttemptResult<string>> => {
    attempts++;
    return { outcome: "failure", failure: { error: new Error(`fail #${attempts}`), retryable: true } };
  };

  await assert.rejects(
    () => callWithRetry<string>(alwaysFails, { maxAttempts: 3, baseDelayMs: 10, sleep }),
    /fail #3/
  );

  assert.equal(attempts, 3, "should try exactly maxAttempts times, no more");
});

test("honors an explicit retryAfterMs instead of the computed backoff", async () => {
  const { sleep, delays } = recordingSleep();
  let attempts = 0;

  await callWithRetry<string>(
    async () => {
      attempts++;
      if (attempts === 1) {
        return {
          outcome: "failure",
          failure: { error: new Error("rate limited"), retryable: true, retryAfterMs: 5000 },
        };
      }
      return { outcome: "success", result: "ok" };
    },
    { maxAttempts: 3, baseDelayMs: 100, sleep }
  );

  assert.deepEqual(delays, [5000], "should wait exactly what Telegram told us, not the computed backoff");
});

test("onRetry is called before each retry sleep, with the attempt number, delay, and error", async () => {
  const { sleep } = recordingSleep();
  const onRetryCalls: Array<{ attemptNumber: number; delayMs: number; message: string }> = [];
  let attempts = 0;

  await callWithRetry<string>(
    async () => {
      attempts++;
      if (attempts < 3) {
        return { outcome: "failure", failure: { error: new Error(`transient #${attempts}`), retryable: true } };
      }
      return { outcome: "success", result: "ok" };
    },
    {
      maxAttempts: 5,
      baseDelayMs: 100,
      sleep,
      onRetry: (attemptNumber, delayMs, error) => {
        onRetryCalls.push({ attemptNumber, delayMs, message: error.message });
      },
    }
  );

  assert.equal(onRetryCalls.length, 2, "should fire once per retry, not per attempt");
  assert.deepEqual(onRetryCalls[0], { attemptNumber: 1, delayMs: 100, message: "transient #1" });
  assert.deepEqual(onRetryCalls[1], { attemptNumber: 2, delayMs: 200, message: "transient #2" });
});

test("onRetry is never called when the first attempt succeeds", async () => {
  const { sleep } = recordingSleep();
  let onRetryCallCount = 0;

  await callWithRetry<string>(async () => ({ outcome: "success", result: "ok" }), {
    maxAttempts: 3,
    baseDelayMs: 100,
    sleep,
    onRetry: () => {
      onRetryCallCount++;
    },
  });

  assert.equal(onRetryCallCount, 0);
});

test("computeBackoffMs doubles from the base delay", () => {
  assert.equal(computeBackoffMs(1, 100), 100);
  assert.equal(computeBackoffMs(2, 100), 200);
  assert.equal(computeBackoffMs(3, 100), 400);
});
