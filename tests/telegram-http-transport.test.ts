import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpTelegramTransport } from "../src/adapters/telegram/HttpTelegramTransport";
import { TelegramApiError, TelegramNetworkError } from "../src/adapters/telegram/TelegramTransport";
import { fakeLogger } from "./support/FakeLogger";

interface RecordedRequest {
  url: string;
  body: unknown;
}

/** A queue of canned responses (or thrown errors) a fake `fetch` hands out in order, recording every call it received. */
function fakeFetch(script: Array<Response | Error>) {
  const requests: RecordedRequest[] = [];
  let callIndex = 0;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const next = script[callIndex];
    callIndex++;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as typeof fetch;

  return { fetchImpl, requests, callCount: () => callIndex };
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function errorResponse(statusCode: number, description: string, retryAfter?: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: statusCode,
      description,
      ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
    }),
    { status: statusCode }
  );
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

test("sendMessage posts to the correct method URL with the chat id and text", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  await transport.sendMessage(555, "Hello!");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.telegram.org/botTEST:TOKEN/sendMessage");
  assert.deepEqual(requests[0].body, { chat_id: 555, text: "Hello!" });
});

test("sendChatAction posts the typing action", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  await transport.sendChatAction(555, "typing");

  assert.deepEqual(requests[0].body, { chat_id: 555, action: "typing" });
});

test("getMe returns the bot's identity", async () => {
  const { fetchImpl } = fakeFetch([okResponse({ id: 42, username: "nuteco_bot" })]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  const me = await transport.getMe();

  assert.deepEqual(me, { id: 42, username: "nuteco_bot" });
});

test("setWebhook includes the secret token when provided", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  await transport.setWebhook("https://example.com/telegram/webhook", "s3cr3t");

  assert.deepEqual(requests[0].body, {
    url: "https://example.com/telegram/webhook",
    secret_token: "s3cr3t",
  });
});

test("retries after a 429 and honors Telegram's retry_after exactly", async () => {
  const { sleep, delays } = recordingSleep();
  const { fetchImpl, requests } = fakeFetch([errorResponse(429, "Too Many Requests", 2), okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl, sleep, maxAttempts: 3 });

  await transport.sendMessage(555, "hi");

  assert.equal(requests.length, 2, "should have retried exactly once");
  assert.deepEqual(delays, [2000], "should wait exactly retry_after (in ms), not a guessed backoff");
});

test("retries a 5xx error and eventually gives up, throwing TelegramApiError", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl, requests } = fakeFetch([
    errorResponse(500, "Internal Server Error"),
    errorResponse(502, "Bad Gateway"),
    errorResponse(500, "Internal Server Error"),
  ]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl, sleep, maxAttempts: 3 });

  await assert.rejects(() => transport.sendMessage(555, "hi"), TelegramApiError);
  assert.equal(requests.length, 3);
});

test("does not retry a 400 (bad request) -- fails immediately", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl, requests } = fakeFetch([errorResponse(400, "chat not found")]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl, sleep, maxAttempts: 5 });

  await assert.rejects(() => transport.sendMessage(555, "hi"), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.statusCode, 400);
    return true;
  });
  assert.equal(requests.length, 1, "a non-retryable error should not be retried");
});

test("retries a network-level failure and eventually throws TelegramNetworkError", async () => {
  const { sleep } = recordingSleep();
  const networkError = new TypeError("fetch failed");
  const { fetchImpl, requests } = fakeFetch([networkError, networkError, networkError]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl, sleep, maxAttempts: 3 });

  await assert.rejects(() => transport.sendMessage(555, "hi"), TelegramNetworkError);
  assert.equal(requests.length, 3);
});

test("a 401 error message explains it's likely an invalid token, not just Telegram's raw description", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl } = fakeFetch([errorResponse(401, "Unauthorized")]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl, sleep, maxAttempts: 1 });

  await assert.rejects(() => transport.getMe(), /TELEGRAM_BOT_TOKEN is invalid.*@BotFather/s);
});

test("logs telegram_api.error on every failed call, without ever including the bot token", async () => {
  const { sleep } = recordingSleep();
  const { logger, entries } = fakeLogger();
  const { fetchImpl } = fakeFetch([errorResponse(400, "chat not found")]);
  const transport = new HttpTelegramTransport({
    botToken: "123456789:AAExampleTokenText1234567890abcdef",
    fetchImpl,
    sleep,
    maxAttempts: 1,
    logger,
  });

  await assert.rejects(() => transport.sendMessage(555, "hi"));

  const errorLogs = entries.filter((e) => e.event === "telegram_api.error");
  assert.equal(errorLogs.length, 1);
  assert.equal(errorLogs[0].fields.method, "sendMessage");
  assert.equal(errorLogs[0].fields.statusCode, 400);
  assert.equal(errorLogs[0].fields.retryable, false);

  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /123456789:AAExampleTokenText1234567890abcdef/, "the bot token must never appear in any logged field");
});

test("logs telegram_api.retry once per retry, and telegram_api.error for the underlying failure", async () => {
  const { sleep } = recordingSleep();
  const { logger, entries } = fakeLogger();
  const { fetchImpl } = fakeFetch([errorResponse(500, "Internal Server Error"), okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl, sleep, maxAttempts: 3, logger });

  await transport.sendMessage(555, "hi");

  assert.equal(entries.filter((e) => e.event === "telegram_api.error").length, 1);
  assert.equal(entries.filter((e) => e.event === "telegram_api.retry").length, 1);
});
