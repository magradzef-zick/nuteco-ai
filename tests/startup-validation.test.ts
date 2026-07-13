import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  runStartupChecks,
  knowledgeBaseCheck,
  systemPromptCheck,
  databaseCheck,
  telegramTokenCheck,
  llmProviderCheck,
  StartupValidationError,
  type StartupCheck,
} from "../src/startup/validateStartup";
import { FakeTelegramTransport } from "./support/FakeTelegramTransport";
import type { LlmProvider } from "../src/llm/LlmProvider";
import { fakeLogger } from "./support/FakeLogger";

test("passes when every check succeeds", async () => {
  await runStartupChecks([
    { name: "a", run: async () => {} },
    { name: "b", run: async () => {} },
  ]);
  // no throw = pass
});

test("logs a startup.check_passed / startup.check_failed event for every check, individually", async () => {
  const { logger, entries } = fakeLogger();

  await assert.rejects(() =>
    runStartupChecks(
      [
        { name: "a", run: async () => {} },
        {
          name: "b",
          run: async () => {
            throw new Error("b is broken");
          },
        },
      ],
      logger
    )
  );

  assert.deepEqual(
    entries.map((e) => [e.event, e.fields.check]),
    [
      ["startup.check_passed", "a"],
      ["startup.check_failed", "b"],
    ]
  );
});

test("collects every failure rather than stopping at the first", async () => {
  const checks: StartupCheck[] = [
    { name: "a", run: async () => {} },
    {
      name: "b",
      run: async () => {
        throw new Error("b is broken");
      },
    },
    {
      name: "c",
      run: async () => {
        throw new Error("c is broken too");
      },
    },
  ];

  try {
    await runStartupChecks(checks);
    assert.fail("expected runStartupChecks to throw");
  } catch (error) {
    assert.ok(error instanceof StartupValidationError);
    assert.equal(error.failures.length, 2);
    assert.equal(error.failures[0].name, "b");
    assert.equal(error.failures[1].name, "c");
    assert.match(error.message, /b is broken/);
    assert.match(error.message, /c is broken too/);
  }
});

test("knowledgeBaseCheck fails clearly if the knowledge base is empty", async () => {
  const check = knowledgeBaseCheck(() => "");
  await assert.rejects(() => check.run(), /empty/);
});

test("knowledgeBaseCheck passes when content is present", async () => {
  const check = knowledgeBaseCheck(() => "## Source: company.md\n\nNuteco Premium...");
  await check.run(); // should not throw
});

test("systemPromptCheck fails clearly if the prompt is empty", async () => {
  const check = systemPromptCheck(() => "");
  await assert.rejects(() => check.run(), /empty/);
});

test("systemPromptCheck passes when content is present", async () => {
  const check = systemPromptCheck(() => "You are the Nuteco assistant...");
  await check.run(); // should not throw
});

test("databaseCheck passes against a real, open database connection", async () => {
  const db = new Database(":memory:");
  const check = databaseCheck(db);
  await check.run(); // should not throw
  db.close();
});

test("databaseCheck fails clearly if the connection is unusable (e.g. already closed)", async () => {
  const db = new Database(":memory:");
  db.close();

  const check = databaseCheck(db);
  await assert.rejects(() => check.run(), /did not respond to a simple query/);
});

test("telegramTokenCheck fails with a clear, actionable message on an invalid token", async () => {
  const transport = new FakeTelegramTransport();
  transport.getMeError = new Error("401 Unauthorized");

  const check = telegramTokenCheck(transport);
  await assert.rejects(() => check.run(), /Telegram rejected this bot token.*@BotFather/s);
});

test("telegramTokenCheck passes for a valid token", async () => {
  const transport = new FakeTelegramTransport();
  const check = telegramTokenCheck(transport);
  await check.run();
  assert.deepEqual(transport.calls, [{ method: "getMe" }]);
});

function fakeLlmProvider(healthCheckError?: Error): LlmProvider {
  return {
    generateReply: async () => ({ text: "", truncated: false }),
    checkHealth: async () => {
      if (healthCheckError) throw healthCheckError;
    },
  };
}

test("llmProviderCheck passes when the provider's health check succeeds", async () => {
  const check = llmProviderCheck(fakeLlmProvider());
  await check.run(); // should not throw
});

test("llmProviderCheck fails with a clear, actionable message when the health check fails", async () => {
  const check = llmProviderCheck(fakeLlmProvider(new Error("API key not valid")));
  await assert.rejects(() => check.run(), /GEMINI_API_KEY.*GEMINI_MODEL/s);
});
