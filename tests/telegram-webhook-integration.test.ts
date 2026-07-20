import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createTelegramWebhookHandler } from "../src/adapters/telegram/webhookRouter";
import { MessageDebouncer } from "../src/engine/MessageDebouncer";
import { InMemoryCustomerIdentityRepository } from "../src/storage/memory/InMemoryCustomerIdentityRepository";
import { InMemoryConversationStateRepository } from "../src/storage/memory/InMemoryConversationStateRepository";
import { createConversationEngine } from "../src/engine/ConversationEngine";
import { TelegramMessageSender } from "../src/adapters/telegram/TelegramMessageSender";
import { FakeTelegramTransport } from "./support/FakeTelegramTransport";
import { FakeLlmProvider } from "./support/FakeLlmProvider";
import { fakeLogger } from "./support/FakeLogger";
import { handleIncomingTelegramUpdate } from "../src/composition";

const TEST_SYSTEM_PROMPT = "You are the test assistant.";
const TEST_KNOWLEDGE_BASE = "Almond flour costs 150.000 per kg.";
const TEST_LLM_REPLY = "Thanks for your message -- a team member will follow up soon.";

/**
 * Full-pipeline integration tests: a real local HTTP server hosting the
 * real webhook handler, receiving real HTTP POST requests (via fetch)
 * shaped exactly like Telegram's webhook deliveries, flowing through the
 * real parser, the real debouncer, and the real ConversationEngine (with a
 * real in-memory identity/state repository) -- with only the Telegram Bot
 * API and the LLM provider faked, via FakeTelegramTransport and
 * FakeLlmProvider.
 */
function setupServer(options: { secretToken?: string } = {}) {
  const transport = new FakeTelegramTransport();
  const messageSender = new TelegramMessageSender({ transport, sleep: async () => {} });
  const identityRepository = new InMemoryCustomerIdentityRepository();
  const conversationStateRepository = new InMemoryConversationStateRepository();
  const debouncer = new MessageDebouncer();
  const llmProvider = new FakeLlmProvider([TEST_LLM_REPLY]);
  const { logger, entries: logEntries } = fakeLogger();
  const handleMessages = createConversationEngine({
    llmProvider,
    messageSender,
    identityRepository,
    conversationStateRepository,
    getSystemPromptText: () => TEST_SYSTEM_PROMPT,
    getKnowledgeBaseText: () => TEST_KNOWLEDGE_BASE,
    now: () => 1_700_000_000_000,
    logger,
    managerNotificationRecipientId: "telegram:999999999",
  });

  const webhookHandler = createTelegramWebhookHandler({
    secretToken: options.secretToken ?? null,
    onUpdate: (update) => handleIncomingTelegramUpdate(update, { debouncer, handleMessages, logger }),
    logger,
  });

  const server = createServer(webhookHandler);

  return { server, transport, identityRepository, logEntries };
}

/** Fails the test loudly if anything logged an unexpected processing error -- the equivalent of the old "onProcessingError: throw" behavior, now expressed against the logger. */
function assertNoUnexpectedProcessingErrors(logEntries: ReturnType<typeof fakeLogger>["entries"]) {
  const unexpected = logEntries.filter((e) => e.event === "webhook.processing_error");
  assert.equal(unexpected.length, 0, `unexpected processing error(s) logged: ${JSON.stringify(unexpected)}`);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function telegramTextUpdate(updateId: number, messageId: number, chatId: number, text: string, headers: Record<string, string> = {}) {
  return {
    body: {
      update_id: updateId,
      message: { message_id: messageId, date: 1_700_000_000, chat: { id: chatId }, text },
    },
    headers,
  };
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("a real text message flows end-to-end: 200 ack, identity recorded, typing + reply sent", async () => {
  const { server, transport, identityRepository, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const { body } = telegramTextUpdate(1, 100, 555, "What's the price of almond flour?");
    const response = await post(baseUrl, "/telegram/webhook", body);
    assert.equal(response.status, 200);

    // onUpdate runs asynchronously after the response is sent -- give the
    // event loop one tick to let it finish before asserting side effects.
    await new Promise((resolve) => setImmediate(resolve));

    const identity = await identityRepository.findById("telegram:555");
    assert.ok(identity, "the customer's contact should have been recorded");

    assert.deepEqual(
      transport.calls.map((c) => c.method),
      ["sendChatAction", "sendMessage"],
      "should show typing, then send exactly one reply"
    );

    assertNoUnexpectedProcessingErrors(logEntries);
    assert.ok(logEntries.some((e) => e.event === "webhook.received"));
    assert.ok(logEntries.some((e) => e.event === "conversation.started" && e.fields.customerId === "telegram:555"));
    assert.ok(logEntries.some((e) => e.event === "conversation.ended" && e.fields.customerId === "telegram:555"));
  } finally {
    await closeServer(server);
  }
});

test("a duplicate webhook delivery of the same update results in only one reply, not two", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const { body } = telegramTextUpdate(2, 101, 556, "Hello");

    const first = await post(baseUrl, "/telegram/webhook", body);
    assert.equal(first.status, 200);
    await new Promise((resolve) => setImmediate(resolve));

    // Telegram redelivers the same update, e.g. because our first 200
    // response was slow or dropped in transit.
    const second = await post(baseUrl, "/telegram/webhook", body);
    assert.equal(second.status, 200, "the webhook should still ack a duplicate, not error");
    await new Promise((resolve) => setImmediate(resolve));

    const sendCount = transport.calls.filter((c) => c.method === "sendMessage").length;
    assert.equal(sendCount, 1, "the duplicate delivery must not trigger a second reply");

    assertNoUnexpectedProcessingErrors(logEntries);
    assert.ok(
      logEntries.some((e) => e.event === "message.duplicate_ignored"),
      "the duplicate should be explicitly logged, not silently dropped"
    );
  } finally {
    await closeServer(server);
  }
});

test("two rapid distinct messages from the same customer are each answered, not dropped", async () => {
  const { server, transport } = setupServer();
  const baseUrl = await listen(server);

  try {
    const first = telegramTextUpdate(3, 102, 557, "First question").body;
    const second = telegramTextUpdate(4, 103, 557, "Second question").body;

    await Promise.all([post(baseUrl, "/telegram/webhook", first), post(baseUrl, "/telegram/webhook", second)]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const sendCount = transport.calls.filter((c) => c.method === "sendMessage").length;
    assert.equal(sendCount, 2, "both distinct messages should eventually get a reply");
  } finally {
    await closeServer(server);
  }
});

test("a non-POST request is rejected with 405", async () => {
  const { server, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/telegram/webhook`, { method: "GET" });
    assert.equal(response.status, 405);
    assert.ok(logEntries.some((e) => e.event === "webhook.rejected_method"));
  } finally {
    await closeServer(server);
  }
});

test("a request missing the required secret token is rejected with 401", async () => {
  const { server, logEntries } = setupServer({ secretToken: "correct-secret" });
  const baseUrl = await listen(server);

  try {
    const { body } = telegramTextUpdate(5, 104, 558, "Hi");
    const response = await post(baseUrl, "/telegram/webhook", body); // no header sent
    assert.equal(response.status, 401);
    assert.ok(logEntries.some((e) => e.event === "webhook.rejected_unauthorized"));
  } finally {
    await closeServer(server);
  }
});

test("a request with the wrong secret token is rejected with 401", async () => {
  const { server } = setupServer({ secretToken: "correct-secret" });
  const baseUrl = await listen(server);

  try {
    const { body } = telegramTextUpdate(6, 105, 559, "Hi");
    const response = await post(baseUrl, "/telegram/webhook", body, {
      "x-telegram-bot-api-secret-token": "wrong-secret",
    });
    assert.equal(response.status, 401);
  } finally {
    await closeServer(server);
  }
});

test("a secret token of the wrong length is rejected with 401, not a thrown error", async () => {
  const { server } = setupServer({ secretToken: "correct-secret" });
  const baseUrl = await listen(server);

  try {
    const { body } = telegramTextUpdate(9, 107, 561, "Hi");
    const response = await post(baseUrl, "/telegram/webhook", body, {
      "x-telegram-bot-api-secret-token": "short",
    });
    assert.equal(response.status, 401);
  } finally {
    await closeServer(server);
  }
});

test("a request with the correct secret token is accepted", async () => {
  const { server, transport } = setupServer({ secretToken: "correct-secret" });
  const baseUrl = await listen(server);

  try {
    const { body } = telegramTextUpdate(7, 106, 560, "Hi");
    const response = await post(baseUrl, "/telegram/webhook", body, {
      "x-telegram-bot-api-secret-token": "correct-secret",
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(transport.calls.some((c) => c.method === "sendMessage"));
  } finally {
    await closeServer(server);
  }
});

test("a malformed JSON body is acknowledged (so Telegram stops retrying it) but produces no reply", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not valid json",
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.calls.length, 0);
    assert.ok(logEntries.some((e) => e.event === "webhook.parse_error"), "the parse failure should be logged, not silent");
  } finally {
    await closeServer(server);
  }
});

test("an unsupported update type (e.g. callback_query) is acknowledged and ignored, not treated as an error", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const response = await post(baseUrl, "/telegram/webhook", {
      update_id: 8,
      callback_query: { id: "cb", data: "x" },
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.calls.length, 0);
    assertNoUnexpectedProcessingErrors(logEntries);
    assert.ok(logEntries.some((e) => e.event === "webhook.update_unsupported" && e.fields.updateType === "callback_query"));
  } finally {
    await closeServer(server);
  }
});

test("a request body over the size limit is rejected with 413, not buffered indefinitely", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const oversized = "x".repeat(1_000_001);
    const response = await fetch(`${baseUrl}/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    assert.equal(response.status, 413);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.calls.length, 0);
    assert.ok(logEntries.some((e) => e.event === "webhook.rejected_body_too_large"));
  } finally {
    await closeServer(server);
  }
});
