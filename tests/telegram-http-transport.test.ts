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

test("sendMessage includes reply_markup when a keyboard is passed", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });
  const replyMarkup = {
    keyboard: [[{ text: "📞 Отправить номер", request_contact: true as const }]],
    resize_keyboard: true as const,
    one_time_keyboard: true as const,
  };

  await transport.sendMessage(555, "Оставьте номер.", replyMarkup);

  assert.deepEqual(requests[0].body, { chat_id: 555, text: "Оставьте номер.", reply_markup: replyMarkup });
});

test("sendMessage includes business_connection_id when replying in a Telegram Business chat", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  await transport.sendMessage(555, "Здравствуйте!", undefined, "biz-conn-abc123");

  assert.deepEqual(requests[0].body, { chat_id: 555, text: "Здравствуйте!", business_connection_id: "biz-conn-abc123" });
});

test("sendChatAction includes business_connection_id when provided", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  await transport.sendChatAction(555, "typing", "biz-conn-abc123");

  assert.deepEqual(requests[0].body, { chat_id: 555, action: "typing", business_connection_id: "biz-conn-abc123" });
});

test("forwardMessage posts from_chat_id, chat_id, and message_id", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  await transport.forwardMessage(999, 555, 42);

  assert.equal(requests[0].url, "https://api.telegram.org/botTEST:TOKEN/forwardMessage");
  assert.deepEqual(requests[0].body, { chat_id: 999, from_chat_id: 555, message_id: 42 });
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

test("setWebhook includes allowed_updates when provided (e.g. to opt in to Telegram Business updates)", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse(true)]);
  const transport = new HttpTelegramTransport({ botToken: "TEST:TOKEN", fetchImpl });

  await transport.setWebhook("https://example.com/telegram/webhook", undefined, ["message", "business_message"]);

  assert.deepEqual(requests[0].body, {
    url: "https://example.com/telegram/webhook",
    allowed_updates: ["message", "business_message"],
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

test("downloadFile resolves a file_id through getFile, then fetches the bytes from Telegram's separate file host", async () => {
  const { fetchImpl, requests } = fakeFetch([
    okResponse({ file_id: "voice-1", file_path: "voice/file_7.oga", file_size: 9_000 }),
    new Response(Buffer.from("audio-bytes"), { status: 200, headers: { "content-type": "audio/ogg" } }),
  ]);
  const transport = new HttpTelegramTransport({ botToken: "TOKEN", fetchImpl, sleep: async () => {}, logger: fakeLogger().logger });

  const file = await transport.downloadFile("voice-1");

  assert.deepEqual(requests[0].body, { file_id: "voice-1" });
  assert.match(requests[0].url, /\/botTOKEN\/getFile$/);
  assert.match(requests[1].url, /\/file\/botTOKEN\/voice\/file_7\.oga$/, "file content comes from /file/bot<token>/, not the API path");
  assert.equal(file.dataBase64, Buffer.from("audio-bytes").toString("base64"));
  assert.equal(file.mimeType, "audio/ogg");
});

test("downloadFile rejects an oversized file from getFile's own metadata, without transferring a single byte", async () => {
  const { fetchImpl, callCount } = fakeFetch([
    okResponse({ file_id: "video-1", file_path: "videos/file_1.mp4", file_size: 48 * 1024 * 1024 }),
  ]);
  const transport = new HttpTelegramTransport({ botToken: "TOKEN", fetchImpl, sleep: async () => {}, logger: fakeLogger().logger });

  await assert.rejects(() => transport.downloadFile("video-1"), { name: "TelegramFileTooLargeError" });
  assert.equal(callCount(), 1, "downloading 48 MB only to reject it afterwards would waste the customer's time and ours");
});

test("downloadFile still catches an oversized file when Telegram omits file_size, which it is allowed to do", async () => {
  const { fetchImpl } = fakeFetch([
    okResponse({ file_id: "video-2", file_path: "videos/file_2.mp4" }),
    new Response(Buffer.alloc(16 * 1024 * 1024), { status: 200, headers: { "content-type": "video/mp4" } }),
  ]);
  const transport = new HttpTelegramTransport({ botToken: "TOKEN", fetchImpl, sleep: async () => {}, logger: fakeLogger().logger });

  await assert.rejects(() => transport.downloadFile("video-2"), { name: "TelegramFileTooLargeError" });
});

test("downloadFile reports a missing file_path plainly -- Telegram returns this for files above its own serving limit", async () => {
  const { fetchImpl } = fakeFetch([okResponse({ file_id: "video-3", file_size: 1_000 })]);
  const transport = new HttpTelegramTransport({ botToken: "TOKEN", fetchImpl, sleep: async () => {}, logger: fakeLogger().logger });

  await assert.rejects(() => transport.downloadFile("video-3"), (error: TelegramApiError) => {
    assert.equal(error.name, "TelegramApiError");
    assert.match(error.message, /file_path/);
    return true;
  });
});

test("downloadFile treats a generic octet-stream content type as no information, leaving the caller to use the message's own", async () => {
  const { fetchImpl } = fakeFetch([
    okResponse({ file_id: "doc-1", file_path: "documents/file_1", file_size: 100 }),
    new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "application/octet-stream" } }),
  ]);
  const transport = new HttpTelegramTransport({ botToken: "TOKEN", fetchImpl, sleep: async () => {}, logger: fakeLogger().logger });

  assert.equal((await transport.downloadFile("doc-1")).mimeType, null);
});

test("downloadFile never logs the URL it fetched, which embeds the bot token", async () => {
  const { logger, entries } = fakeLogger();
  const { fetchImpl } = fakeFetch([
    okResponse({ file_id: "voice-1", file_path: "voice/file_7.oga", file_size: 100 }),
    new TelegramNetworkError("boom", new Error("boom")),
  ]);
  const transport = new HttpTelegramTransport({ botToken: "SECRET-TOKEN", fetchImpl, sleep: async () => {}, logger });

  await assert.rejects(() => transport.downloadFile("voice-1"));
  assert.ok(entries.length > 0, "the failure must still be logged");
  assert.ok(!JSON.stringify(entries).includes("SECRET-TOKEN"));
});
