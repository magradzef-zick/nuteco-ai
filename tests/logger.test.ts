import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/observability/logger";

/** Captures console.log/console.error output for the duration of `fn`, then restores the originals -- even if fn throws. */
async function captureConsole(fn: () => void | Promise<void>): Promise<{ logLines: string[]; errorLines: string[] }> {
  const logLines: string[] = [];
  const errorLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (line: string) => logLines.push(line);
  console.error = (line: string) => errorLines.push(line);

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { logLines, errorLines };
}

test("info/debug write to stdout (console.log), warn/error write to stderr (console.error)", async () => {
  const logger = createLogger();

  const { logLines, errorLines } = await captureConsole(() => {
    logger.debug("test.debug");
    logger.info("test.info");
    logger.warn("test.warn");
    logger.error("test.error");
  });

  assert.equal(logLines.length, 2);
  assert.equal(errorLines.length, 2);
});

test("every log line is valid JSON with timestamp, level, and event", async () => {
  const logger = createLogger();
  const { logLines } = await captureConsole(() => {
    logger.info("order.collected", { customerId: "telegram:555" });
  });

  const entry = JSON.parse(logLines[0]);
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "order.collected");
  assert.equal(entry.customerId, "telegram:555");
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)), "timestamp should be a valid ISO date");
});

test("a field literally named 'token' is redacted regardless of its value", async () => {
  const logger = createLogger();
  const { logLines } = await captureConsole(() => {
    logger.info("startup.success", { botToken: "123456789:AAExampleTokenText1234567890abcdef" });
  });

  const entry = JSON.parse(logLines[0]);
  assert.equal(entry.botToken, "[REDACTED]");
});

test("fields named secret/password/apiKey are also redacted", async () => {
  const logger = createLogger();
  const { logLines } = await captureConsole(() => {
    logger.info("test.event", {
      telegramWebhookSecretToken: "shh",
      accountPassword: "hunter2",
      apiKey: "abc123",
    });
  });

  const entry = JSON.parse(logLines[0]);
  assert.equal(entry.telegramWebhookSecretToken, "[REDACTED]");
  assert.equal(entry.accountPassword, "[REDACTED]");
  assert.equal(entry.apiKey, "[REDACTED]");
});

test("a Google API key-shaped string is redacted even inside an unrelated field, e.g. a Gemini request URL", async () => {
  const logger = createLogger();
  const fakeKey = "AIzaSyExampleKeyText1234567890abcdefg";
  const { errorLines } = await captureConsole(() => {
    logger.error("gemini_api.error", {
      requestUrl: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${fakeKey}`,
    });
  });

  const entry = JSON.parse(errorLines[0]);
  assert.doesNotMatch(entry.requestUrl, new RegExp(fakeKey));
  assert.match(entry.requestUrl, /\[REDACTED_TOKEN\]/);
});

test("a key=... query value is redacted even when it doesn't match the AIza-prefixed shape (a real key was seen in this exact non-AIza form)", async () => {
  const logger = createLogger();
  const nonAizaShapedKey = "AQ.ExampleNonAizaShapedKeyText1234567890abcdefg";
  const { errorLines } = await captureConsole(() => {
    logger.error("gemini_api.error", {
      requestUrl: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${nonAizaShapedKey}`,
    });
  });

  const entry = JSON.parse(errorLines[0]);
  assert.doesNotMatch(entry.requestUrl, new RegExp(nonAizaShapedKey.replace(/\./g, "\\.")));
  assert.match(entry.requestUrl, /\[REDACTED_TOKEN\]/);
});

test("a bot-token-shaped string is redacted even inside an unrelated field, e.g. a URL", async () => {
  const logger = createLogger();
  const { errorLines } = await captureConsole(() => {
    logger.error("telegram_api.error", {
      requestUrl: "https://api.telegram.org/bot123456789:AAExampleTokenText1234567890abcdef/sendMessage",
    });
  });

  const entry = JSON.parse(errorLines[0]);
  assert.doesNotMatch(entry.requestUrl, /123456789:AAExampleTokenText1234567890abcdef/);
  assert.match(entry.requestUrl, /\[REDACTED_TOKEN\]/);
});

test("a bot token embedded inside an Error's message is redacted", async () => {
  const logger = createLogger();
  const error = new Error(
    "Network error calling https://api.telegram.org/bot123456789:AAExampleTokenText1234567890abcdef/getMe"
  );

  const { errorLines } = await captureConsole(() => {
    logger.error("telegram_api.error", { error });
  });

  const entry = JSON.parse(errorLines[0]);
  assert.doesNotMatch(entry.error.message, /123456789:AAExampleTokenText1234567890abcdef/);
});

test("redaction recurses into nested objects", async () => {
  const logger = createLogger();
  const { logLines } = await captureConsole(() => {
    logger.info("test.event", { config: { telegramBotToken: "123456789:AAExampleTokenText1234567890abcdef" } });
  });

  const entry = JSON.parse(logLines[0]);
  assert.equal(entry.config.telegramBotToken, "[REDACTED]");
});

test("ordinary, non-sensitive fields pass through unchanged", async () => {
  const logger = createLogger();
  const { logLines } = await captureConsole(() => {
    logger.info("message.duplicate_ignored", { customerId: "telegram:555", messageId: "555:42" });
  });

  const entry = JSON.parse(logLines[0]);
  assert.equal(entry.customerId, "telegram:555");
  assert.equal(entry.messageId, "555:42");
});
