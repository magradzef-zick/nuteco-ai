import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigValidationError, securityWarnings } from "../src/config/config";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: "123:ABC",
    MANAGER_NOTIFICATION_CHAT_ID: "-100123456",
    GEMINI_API_KEY: "AIzaSyFAKEKEYFORTESTSONLY0000000000",
    ...overrides,
  };
}

test("loads a valid, complete environment", () => {
  const config = loadConfig(
    baseEnv({
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "shh",
      KNOWLEDGE_BASE_DIR: "/custom/knowledge",
      PROMPTS_DIR: "/custom/prompts",
      DATABASE_PATH: "/custom/db.sqlite",
      GEMINI_MODEL: "gemini-2.5-pro",
      PORT: "8080",
    })
  );

  assert.equal(config.telegramBotToken, "123:ABC");
  assert.equal(config.managerNotificationChatId, "-100123456");
  assert.equal(config.telegramWebhookSecretToken, "shh");
  assert.equal(config.geminiApiKey, "AIzaSyFAKEKEYFORTESTSONLY0000000000");
  assert.equal(config.geminiModel, "gemini-2.5-pro");
  assert.equal(config.knowledgeBaseDir, "/custom/knowledge");
  assert.equal(config.promptsDir, "/custom/prompts");
  assert.equal(config.databasePath, "/custom/db.sqlite");
  assert.equal(config.port, 8080);
});

test("applies sensible defaults for optional settings", () => {
  const config = loadConfig(baseEnv());

  assert.equal(config.telegramWebhookSecretToken, null);
  assert.equal(config.geminiModel, "gemini-2.5-flash");
  assert.equal(config.knowledgeBaseDir, "./knowledge");
  assert.equal(config.promptsDir, "./prompts");
  assert.equal(config.databasePath, "./data/nuteco.db");
  assert.equal(config.port, 3000);
  assert.equal(config.instagram, null, "Instagram is disabled by default -- a Telegram-only deployment needs no changes");
});

test("Instagram support stays disabled when none of the INSTAGRAM_* variables are set", () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.instagram, null);
});

test("loads a complete Instagram config when every INSTAGRAM_* variable is set", () => {
  const config = loadConfig(
    baseEnv({
      INSTAGRAM_PAGE_ACCESS_TOKEN: "ig-page-token",
      INSTAGRAM_APP_SECRET: "ig-app-secret",
      INSTAGRAM_VERIFY_TOKEN: "ig-verify-token",
      INSTAGRAM_PAGE_ID: "17841400000000000",
    })
  );

  assert.deepEqual(config.instagram, {
    pageAccessToken: "ig-page-token",
    appSecret: "ig-app-secret",
    verifyToken: "ig-verify-token",
    pageId: "17841400000000000",
    graphApiVersion: "v21.0",
  });
});

test("an explicit INSTAGRAM_GRAPH_API_VERSION overrides the default", () => {
  const config = loadConfig(
    baseEnv({
      INSTAGRAM_PAGE_ACCESS_TOKEN: "ig-page-token",
      INSTAGRAM_APP_SECRET: "ig-app-secret",
      INSTAGRAM_VERIFY_TOKEN: "ig-verify-token",
      INSTAGRAM_PAGE_ID: "17841400000000000",
      INSTAGRAM_GRAPH_API_VERSION: "v22.0",
    })
  );

  assert.equal(config.instagram?.graphApiVersion, "v22.0");
});

test("a partially-configured Instagram setup fails loudly, listing every missing INSTAGRAM_* variable", () => {
  try {
    loadConfig(baseEnv({ INSTAGRAM_PAGE_ACCESS_TOKEN: "ig-page-token" }));
    assert.fail("expected loadConfig to throw");
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    assert.ok(error.problems.some((p) => p.includes("INSTAGRAM_APP_SECRET")));
    assert.ok(error.problems.some((p) => p.includes("INSTAGRAM_VERIFY_TOKEN")));
    assert.ok(error.problems.some((p) => p.includes("INSTAGRAM_PAGE_ID")));
    assert.ok(!error.problems.some((p) => p.includes("INSTAGRAM_PAGE_ACCESS_TOKEN")), "the one variable that IS set should not be reported as missing");
  }
});

test("collects every missing required variable in one error, not just the first", () => {
  try {
    loadConfig({});
    assert.fail("expected loadConfig to throw");
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    assert.equal(error.problems.length, 3);
    assert.ok(error.problems.some((p) => p.includes("TELEGRAM_BOT_TOKEN")));
    assert.ok(error.problems.some((p) => p.includes("MANAGER_NOTIFICATION_CHAT_ID")));
    assert.ok(error.problems.some((p) => p.includes("GEMINI_API_KEY")));
  }
});

test("rejects a non-numeric PORT with a clear message", () => {
  try {
    loadConfig(baseEnv({ PORT: "not-a-number" }));
    assert.fail("expected loadConfig to throw");
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    assert.ok(error.problems.some((p) => p.includes("PORT")));
  }
});

test("rejects an out-of-range PORT", () => {
  assert.throws(() => loadConfig(baseEnv({ PORT: "99999" })), ConfigValidationError);
});

test("treats a blank required variable the same as a missing one", () => {
  try {
    loadConfig(baseEnv({ TELEGRAM_BOT_TOKEN: "   " }));
    assert.fail("expected loadConfig to throw");
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    assert.ok(error.problems.some((p) => p.includes("TELEGRAM_BOT_TOKEN")));
  }
});

test("securityWarnings flags a missing webhook secret token", () => {
  const config = loadConfig(baseEnv());
  const warnings = securityWarnings(config);
  assert.ok(warnings.some((w) => w.includes("TELEGRAM_WEBHOOK_SECRET_TOKEN")));
});

test("securityWarnings is silent when a webhook secret token is configured", () => {
  const config = loadConfig(baseEnv({ TELEGRAM_WEBHOOK_SECRET_TOKEN: "shh" }));
  assert.deepEqual(securityWarnings(config), []);
});
