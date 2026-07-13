import { test } from "node:test";
import assert from "node:assert/strict";
import { createConversationEngine } from "../src/engine/ConversationEngine";
import { InMemoryCustomerIdentityRepository } from "../src/storage/memory/InMemoryCustomerIdentityRepository";
import { InMemoryConversationStateRepository } from "../src/storage/memory/InMemoryConversationStateRepository";
import { FakeTelegramTransport } from "./support/FakeTelegramTransport";
import { TelegramMessageSender } from "../src/adapters/telegram/TelegramMessageSender";
import { FakeLlmProvider } from "./support/FakeLlmProvider";
import { fakeLogger } from "./support/FakeLogger";
import type { InboundMessage } from "../src/engine/MessageDebouncer";
import type { LlmProvider } from "../src/llm/LlmProvider";
import type { CustomerIdentityRepository } from "../src/storage/CustomerIdentityRepository";
import type { ConversationStateRepository } from "../src/storage/ConversationStateRepository";
import { fallbackMessage } from "../src/engine/fallbackMessages";

const SYSTEM_PROMPT = "You are the test assistant.";
const KNOWLEDGE_BASE = "Almond flour costs 150.000 per kg.";

const MANAGER_RECIPIENT_ID = "telegram:999999999";

function setup(scriptedReplies: string[], truncatedIndices: number[] = [], llmProviderOverride?: LlmProvider) {
  const transport = new FakeTelegramTransport();
  const messageSender = new TelegramMessageSender({ transport, sleep: async () => {} });
  const identityRepository = new InMemoryCustomerIdentityRepository();
  const conversationStateRepository = new InMemoryConversationStateRepository();
  // Cast is safe here: tests that pass an override never read `.requests`
  // off the returned handle (they use their own reference to the override
  // instead) -- this just keeps the common, no-override call sites
  // type-checking against FakeLlmProvider's richer shape without an
  // awkward union type leaking into every existing test.
  const llmProvider = (llmProviderOverride ?? new FakeLlmProvider(scriptedReplies, truncatedIndices)) as FakeLlmProvider;
  const { logger, entries } = fakeLogger();

  let clock = 1_000_000;
  const handleMessages = createConversationEngine({
    llmProvider,
    messageSender,
    identityRepository,
    conversationStateRepository,
    getSystemPromptText: () => SYSTEM_PROMPT,
    getKnowledgeBaseText: () => KNOWLEDGE_BASE,
    now: () => clock,
    logger,
    managerNotificationRecipientId: MANAGER_RECIPIENT_ID,
  });

  return {
    handleMessages,
    transport,
    identityRepository,
    conversationStateRepository,
    llmProvider,
    logEntries: entries,
    advanceClock: (ms: number) => (clock += ms),
  };
}

function textMessage(customerId: string, messageId: string, text: string): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text, mediaType: null } };
}

function mediaMessage(customerId: string, messageId: string, mediaType: string): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text: null, mediaType } };
}

test("answers a plain text message using the LLM, with the system prompt and knowledge base injected", async () => {
  const { handleMessages, transport, llmProvider } = setup(["Almond flour is 150.000 per kg."]);

  await handleMessages("telegram:1", [textMessage("telegram:1", "m1", "How much is almond flour?")]);

  assert.equal(llmProvider.requests.length, 1);
  assert.equal(llmProvider.requests[0].systemPrompt, `${SYSTEM_PROMPT}\n\n${KNOWLEDGE_BASE}`);
  assert.equal(llmProvider.requests[0].newUserMessage, "How much is almond flour?");
  assert.deepEqual(llmProvider.requests[0].historyTurns, []);

  assert.deepEqual(
    transport.calls.map((c) => c.method),
    ["sendChatAction", "sendMessage"]
  );
  const sendCall = transport.calls[1];
  assert.equal(sendCall.method, "sendMessage");
  if (sendCall.method === "sendMessage") {
    assert.equal(sendCall.text, "Almond flour is 150.000 per kg.");
  }
});

test("a reply with a blank-line break is sent as two separate Telegram messages, not one block with an embedded blank line", async () => {
  const { handleMessages, transport } = setup(["First fact.\n\nSecond, separate fact."]);

  await handleMessages("telegram:9", [textMessage("telegram:9", "m1", "Two things please")]);

  const sendCalls = transport.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sendCalls.length, 2);
  if (sendCalls[0].method === "sendMessage" && sendCalls[1].method === "sendMessage") {
    assert.equal(sendCalls[0].text, "First fact.");
    assert.equal(sendCalls[1].text, "Second, separate fact.");
  }
});

test("a reply with no blank-line break is still sent as a single message", async () => {
  const { handleMessages, transport } = setup(["Just one short answer."]);

  await handleMessages("telegram:10", [textMessage("telegram:10", "m1", "One thing please")]);

  const sendCalls = transport.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sendCalls.length, 1);
});

test("a reply with more blank-line breaks than the cap is folded into at most 4 messages, not sent as a burst", async () => {
  const sixParts = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."].join("\n\n");
  const { handleMessages, transport } = setup([sixParts]);

  await handleMessages("telegram:16", [textMessage("telegram:16", "m1", "Tell me everything")]);

  const sendCalls = transport.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sendCalls.length, 4, "must not send more than the segment cap, regardless of how many blank lines the reply has");
  if (sendCalls[3].method === "sendMessage") {
    assert.match(sendCalls[3].text, /Four\.[\s\S]*Five\.[\s\S]*Six\./, "content past the cap must be folded into the last message, not dropped");
  }
});

test("records customer identity contact", async () => {
  const { handleMessages, identityRepository } = setup(["ok"]);
  await handleMessages("telegram:2", [textMessage("telegram:2", "m1", "hi")]);
  const identity = await identityRepository.findById("telegram:2");
  assert.ok(identity);
});

test("a reply containing a price not present in the knowledge base is blocked and escalated, in the customer's language, with a reason-specific 'I don't want to guess' message", async () => {
  const { handleMessages, transport, logEntries } = setup(["Almond flour is actually 999.000 per kg, a steal!"]);

  await handleMessages("telegram:3", [textMessage("telegram:3", "m1", "How much is almond flour?")]);

  const sendCall = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(sendCall && sendCall.method === "sendMessage");
  assert.doesNotMatch(sendCall.text, /999\.000/, "the fabricated price must never reach the customer");
  assert.equal(sendCall.text, fallbackMessage("unverifiedNumber", "en"), "must be the reason-specific message, in the customer's own language");

  assert.ok(logEntries.some((e) => e.event === "escalation.triggered" && e.fields.reason === "unverified_numbers_in_reply"));
});

test("a reply truncated by the output token limit is blocked and escalated, not sent to the customer as a broken fragment (root cause of a real bug seen live)", async () => {
  const { handleMessages, transport, logEntries } = setup(
    ["Здравствуйте! У нас есть в наличии фисташковая, фундучная, ке"],
    [0]
  );

  await handleMessages("telegram:8", [textMessage("telegram:8", "m1", "What products do you have?")]);

  const sendCall = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(sendCall && sendCall.method === "sendMessage");
  assert.doesNotMatch(sendCall.text, /фисташковая/, "the truncated fragment must never reach the customer");
  assert.equal(sendCall.text, fallbackMessage("technicalHiccup", "en"), "must be in the customer's own language (English, since the customer wrote in English)");

  assert.ok(logEntries.some((e) => e.event === "escalation.triggered" && e.fields.reason === "truncated_reply"));
});

test("PRODUCTION INCIDENT REGRESSION: a Russian-language conversation never gets an English escalation reply, for every fallback path", async () => {
  // This reproduces the exact reported production bug: a customer
  // conversing entirely in Russian/Uzbek received a hardcoded English
  // escalation reply ("I want to make sure you get the right
  // information..."). Root cause: every fallback path bypassed Gemini
  // entirely, so the system prompt's language instruction (which only
  // governs text Gemini itself generates) had no effect on them. Each
  // sub-case below exercises a different fallback path with the same
  // realistic Russian customer message reported in the incident.
  const russianQuestion = "Есть Bodon? Сколько стоит за 1 кг?";

  // Path 1: hallucination guardrail blocks a fabricated price.
  {
    const { handleMessages, transport } = setup(["Bodon стоит 999.000 за кг!"]);
    await handleMessages("telegram:20", [textMessage("telegram:20", "m1", russianQuestion)]);
    const sendCall = transport.calls.find((c) => c.method === "sendMessage");
    assert.ok(sendCall && sendCall.method === "sendMessage");
    assert.doesNotMatch(sendCall.text, /[A-Za-z]{4,}/, "must contain no English word of any length -- this is the exact incident being fixed");
    assert.equal(sendCall.text, fallbackMessage("unverifiedNumber", "ru"));
  }

  // Path 2: the LLM is unreachable.
  {
    const throwingProvider: LlmProvider = {
      generateReply: async () => {
        throw new Error("simulated Gemini outage");
      },
      checkHealth: async () => {},
    };
    const { handleMessages, transport } = setup([], [], throwingProvider);
    await handleMessages("telegram:21", [textMessage("telegram:21", "m1", russianQuestion)]);
    const sendCall = transport.calls.find((c) => c.method === "sendMessage");
    assert.ok(sendCall && sendCall.method === "sendMessage");
    assert.equal(sendCall.text, fallbackMessage("technicalHiccup", "ru"));
  }

  // Path 3: a strong B2B signal short-circuits before the LLM is ever called.
  {
    const { handleMessages, transport } = setup(["should not be used"]);
    await handleMessages("telegram:22", [
      textMessage("telegram:22", "m1", "Нам нужна фисташковая паста оптом, оплата по перечислению"),
    ]);
    const sendCall = transport.calls.find((c) => c.method === "sendMessage");
    assert.ok(sendCall && sendCall.method === "sendMessage");
    assert.equal(sendCall.text, fallbackMessage("b2bEscalation", "ru"));
  }
});

test("PRODUCTION INCIDENT REGRESSION: the same guarantee holds for an Uzbek-language conversation", async () => {
  const { handleMessages, transport } = setup(["Bodom 999.000 dan turadi!"]);

  await handleMessages("telegram:23", [textMessage("telegram:23", "m1", "Bodom narxi qancha 1 kg uchun?")]);

  const sendCall = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(sendCall && sendCall.method === "sendMessage");
  assert.equal(sendCall.text, fallbackMessage("unverifiedNumber", "uz"));
});

test("a media-only message gets a deterministic fallback without calling the LLM", async () => {
  const { handleMessages, transport, llmProvider } = setup(["should not be used"]);

  await handleMessages("telegram:4", [mediaMessage("telegram:4", "m1", "voice")]);

  assert.equal(llmProvider.requests.length, 0, "no LLM call should be made for a pure media message");
  assert.deepEqual(
    transport.calls.map((c) => c.method),
    ["sendMessage"],
    "no typing indicator needed for an instant canned reply"
  );
});

test("conversation history accumulates and is passed to the next LLM call", async () => {
  const { handleMessages, llmProvider } = setup(["First reply.", "Second reply."]);

  await handleMessages("telegram:5", [textMessage("telegram:5", "m1", "First question")]);
  await handleMessages("telegram:5", [textMessage("telegram:5", "m2", "Second question")]);

  assert.equal(llmProvider.requests.length, 2);
  assert.deepEqual(llmProvider.requests[1].historyTurns, [
    { role: "user", text: "First question" },
    { role: "assistant", text: "First reply." },
  ]);
  assert.equal(llmProvider.requests[1].newUserMessage, "Second question");
});

test("multiple text messages coalesced into one batch are joined into a single user message", async () => {
  const { handleMessages, llmProvider } = setup(["ok"]);

  await handleMessages("telegram:6", [
    textMessage("telegram:6", "m1", "First part"),
    textMessage("telegram:6", "m2", "Second part"),
  ]);

  assert.equal(llmProvider.requests[0].newUserMessage, "First part\nSecond part");
});

test("when the LLM provider throws, the customer still gets a graceful reply, never silence", async () => {
  const throwingProvider: LlmProvider = {
    generateReply: async () => {
      throw new Error("simulated Gemini outage");
    },
    checkHealth: async () => {},
  };
  const { handleMessages, transport, logEntries } = setup([], [], throwingProvider);

  await handleMessages("telegram:11", [textMessage("telegram:11", "m1", "How much is almond flour?")]);

  const sendCall = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(sendCall && sendCall.method === "sendMessage", "the customer must receive some reply, not silence");
  assert.equal(sendCall.text, fallbackMessage("technicalHiccup", "en"));

  assert.ok(
    logEntries.some(
      (e) => e.event === "escalation.triggered" && e.fields.reason === "llm_unavailable" && e.fields.customerId === "telegram:11"
    )
  );
});

test("a strong B2B signal escalates immediately without ever calling the LLM (deterministic pre-filter backstop)", async () => {
  const { handleMessages, transport, llmProvider, logEntries } = setup(["should not be used"]);

  await handleMessages("telegram:12", [
    textMessage("telegram:12", "m1", "Здравствуйте, нам нужна фисташковая паста оптом, оплата по перечислению, можно счет-фактуру?"),
  ]);

  assert.equal(llmProvider.requests.length, 0, "a strong B2B signal must short-circuit before any LLM call");

  const sendCall = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(sendCall && sendCall.method === "sendMessage");
  assert.equal(sendCall.text, fallbackMessage("b2bEscalation", "ru"), "the customer wrote in Russian, so the escalation must be in Russian too");

  assert.ok(logEntries.some((e) => e.event === "escalation.triggered" && e.fields.reason === "b2b_signal_detected"));
});

test("an ordinary retail message does not trigger the B2B pre-filter", async () => {
  const { handleMessages, llmProvider } = setup(["Almond flour is 150.000 per kg."]);

  await handleMessages("telegram:13", [textMessage("telegram:13", "m1", "Сколько стоит миндальная мука?")]);

  assert.equal(llmProvider.requests.length, 1, "an ordinary retail question must still reach the LLM normally");
});

test("when the identity/state store is unreachable, the customer gets an honest escalation reply, never silence (fail closed, not open)", async () => {
  const transport = new FakeTelegramTransport();
  const messageSender = new TelegramMessageSender({ transport, sleep: async () => {} });
  const throwingIdentityRepository: CustomerIdentityRepository = {
    findById: async () => null,
    recordContact: async () => {
      throw new Error("simulated database outage");
    },
    confirmB2b: async () => {},
    recordConversationSummary: async () => {},
  };
  const conversationStateRepository = new InMemoryConversationStateRepository();
  const llmProvider = new FakeLlmProvider(["should not be called"]);
  const { logger, entries } = fakeLogger();

  const handleMessages = createConversationEngine({
    llmProvider,
    messageSender,
    identityRepository: throwingIdentityRepository,
    conversationStateRepository,
    getSystemPromptText: () => SYSTEM_PROMPT,
    getKnowledgeBaseText: () => KNOWLEDGE_BASE,
    now: () => 1_000_000,
    logger,
    managerNotificationRecipientId: MANAGER_RECIPIENT_ID,
  });

  await handleMessages("telegram:14", [textMessage("telegram:14", "m1", "Сколько стоит миндальная мука?")]);

  assert.equal(llmProvider.requests.length, 0, "the LLM should never be called if the store is already unreachable");
  const sendCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId !== 999999999);
  assert.ok(sendCall && sendCall.method === "sendMessage", "the customer must receive some reply, not silence");
  assert.equal(sendCall.text, fallbackMessage("technicalHiccup", "ru"), "the customer wrote in Russian, so the fallback must be in Russian too");
  assert.ok(entries.some((e) => e.event === "escalation.triggered" && e.fields.reason === "state_store_unavailable"));

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage", "even a store-outage escalation must still notify the manager");
  assert.match(managerCall.text, /state_store_unavailable/);
});

test("a state-save failure after a successful reply is logged but does not send a second, confusing message", async () => {
  const transport = new FakeTelegramTransport();
  const messageSender = new TelegramMessageSender({ transport, sleep: async () => {} });
  const identityRepository = new InMemoryCustomerIdentityRepository();
  const throwingStateRepository: ConversationStateRepository = {
    get: async () => null,
    save: async () => {
      throw new Error("simulated write failure");
    },
    clear: async () => {},
    deleteExpired: async () => 0,
  };
  const llmProvider = new FakeLlmProvider(["Almond flour is 150.000 per kg."]);
  const { logger, entries } = fakeLogger();

  const handleMessages = createConversationEngine({
    llmProvider,
    messageSender,
    identityRepository,
    conversationStateRepository: throwingStateRepository,
    getSystemPromptText: () => SYSTEM_PROMPT,
    getKnowledgeBaseText: () => KNOWLEDGE_BASE,
    now: () => 1_000_000,
    logger,
    managerNotificationRecipientId: MANAGER_RECIPIENT_ID,
  });

  await handleMessages("telegram:15", [textMessage("telegram:15", "m1", "Сколько стоит миндальная мука?")]);

  const sendCalls = transport.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sendCalls.length, 1, "only the real reply should be sent, not an extra escalation message on top of it");
  if (sendCalls[0].method === "sendMessage") {
    assert.equal(sendCalls[0].text, "Almond flour is 150.000 per kg.");
  }
  assert.ok(entries.some((e) => e.event === "conversation.state_save_failed"));
});

test("a normal, non-escalated reply never notifies the manager", async () => {
  const { handleMessages, transport } = setup(["Almond flour is 150.000 per kg."]);

  await handleMessages("telegram:30", [textMessage("telegram:30", "m1", "How much is almond flour?")]);

  const managerCalls = transport.calls.filter((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.equal(managerCalls.length, 0, "an ordinary answered question must not page the manager");
});

test("when the model itself signals an escalation via the [ESCALATE] marker, the marker is stripped from what the customer sees and the manager is notified", async () => {
  const { handleMessages, transport, logEntries } = setup([
    "Извините, скидки предоставляет только менеджер, я вас с ним свяжу.\n\n[ESCALATE]",
  ]);

  await handleMessages("telegram:31", [textMessage("telegram:31", "m1", "Дайте скидку 20%")]);

  const customerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId !== 999999999);
  assert.ok(customerCall && customerCall.method === "sendMessage");
  assert.doesNotMatch(customerCall.text, /\[ESCALATE\]/, "the marker must never reach the customer");
  assert.match(customerCall.text, /менеджер/);

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage", "the model's own escalation judgment must still notify the manager");
  assert.match(managerCall.text, /llm_judged_escalation/);
  assert.match(managerCall.text, /Дайте скидку 20%/, "the notification should include the customer's actual message for context");

  assert.ok(logEntries.some((e) => e.event === "escalation.triggered" && e.fields.reason === "llm_judged_escalation"));
});

test("the [ESCALATE] marker is only recognized at the very end of a reply, not anywhere it might coincidentally appear", async () => {
  const { handleMessages, transport } = setup(["У нас нет информации про [ESCALATE] в этом контексте, но вот ответ."]);

  await handleMessages("telegram:32", [textMessage("telegram:32", "m1", "Обычный вопрос")]);

  const managerCalls = transport.calls.filter((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.equal(managerCalls.length, 0, "an incidental, non-trailing occurrence of the marker text must not be treated as the model's signal");
});

test("every mechanical escalation path notifies the manager with the matching reason", async () => {
  // b2b_signal_detected
  {
    const { handleMessages, transport } = setup(["should not be used"]);
    await handleMessages("telegram:33", [
      textMessage("telegram:33", "m1", "Нам нужна фисташковая паста оптом, оплата по перечислению"),
    ]);
    const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
    assert.ok(managerCall && managerCall.method === "sendMessage");
    assert.match(managerCall.text, /b2b_signal_detected/);
  }

  // llm_unavailable
  {
    const throwingProvider: LlmProvider = {
      generateReply: async () => {
        throw new Error("simulated outage");
      },
      checkHealth: async () => {},
    };
    const { handleMessages, transport } = setup([], [], throwingProvider);
    await handleMessages("telegram:34", [textMessage("telegram:34", "m1", "Здравствуйте")]);
    const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
    assert.ok(managerCall && managerCall.method === "sendMessage");
    assert.match(managerCall.text, /llm_unavailable/);
  }

  // truncated_reply
  {
    const { handleMessages, transport } = setup(["Незаконченный ответ про фиста"], [0]);
    await handleMessages("telegram:35", [textMessage("telegram:35", "m1", "Что у вас есть?")]);
    const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
    assert.ok(managerCall && managerCall.method === "sendMessage");
    assert.match(managerCall.text, /truncated_reply/);
  }

  // unverified_numbers_in_reply
  {
    const { handleMessages, transport } = setup(["Миндальная мука стоит 999.000 за кг!"]);
    await handleMessages("telegram:36", [textMessage("telegram:36", "m1", "Сколько стоит миндальная мука?")]);
    const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
    assert.ok(managerCall && managerCall.method === "sendMessage");
    assert.match(managerCall.text, /unverified_numbers_in_reply/);
  }
});

test("a failure sending the manager notification is logged but never prevents the customer from getting their own reply", async () => {
  const transport = new FakeTelegramTransport();
  const realSendMessage = transport.sendMessage.bind(transport);
  transport.sendMessage = async (chatId: number, text: string) => {
    if (chatId === 999999999) {
      throw new Error("simulated manager chat unreachable");
    }
    return realSendMessage(chatId, text);
  };
  const messageSender = new TelegramMessageSender({ transport, sleep: async () => {} });
  const identityRepository = new InMemoryCustomerIdentityRepository();
  const conversationStateRepository = new InMemoryConversationStateRepository();
  const llmProvider = new FakeLlmProvider(["should not be used"]);
  const { logger, entries } = fakeLogger();

  const handleMessages = createConversationEngine({
    llmProvider,
    messageSender,
    identityRepository,
    conversationStateRepository,
    getSystemPromptText: () => SYSTEM_PROMPT,
    getKnowledgeBaseText: () => KNOWLEDGE_BASE,
    now: () => 1_000_000,
    logger,
    managerNotificationRecipientId: MANAGER_RECIPIENT_ID,
  });

  await handleMessages("telegram:37", [
    textMessage("telegram:37", "m1", "Нам нужна фисташковая паста оптом, оплата по перечислению"),
  ]);

  const customerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId !== 999999999);
  assert.ok(customerCall && customerCall.method === "sendMessage", "the customer must still get their reply even though notifying the manager failed");
  assert.ok(entries.some((e) => e.event === "manager_notification.failed"));
});

test("history is bounded so it doesn't grow without limit", async () => {
  const replies = Array.from({ length: 15 }, (_, i) => `Reply ${i}`);
  const { handleMessages, llmProvider } = setup(replies);

  for (let i = 0; i < 15; i++) {
    await handleMessages("telegram:7", [textMessage("telegram:7", `m${i}`, `Question ${i}`)]);
  }

  const lastRequest = llmProvider.requests[llmProvider.requests.length - 1];
  assert.ok(lastRequest.historyTurns.length <= 20, "history must stay bounded, not grow forever");
});
