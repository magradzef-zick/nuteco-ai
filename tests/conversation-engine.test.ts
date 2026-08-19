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

function setup(
  scriptedReplies: string[],
  truncatedIndices: number[] = [],
  llmProviderOverride?: LlmProvider,
  downloadMediaOverride?: (fileId: string) => Promise<{ dataBase64: string; mimeType: string | null }>
) {
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
  const forwardedMessages: Array<{ sourceMessageId: string; recipientId: string }> = [];
  const downloadedFileIds: string[] = [];

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
    forwardMessageToRecipient: async (sourceMessageId, recipientId) => {
      forwardedMessages.push({ sourceMessageId, recipientId });
    },
    // Always wired, mirroring the real Telegram deployment. It only ever
    // fires for a payload that actually carries a `mediaFileId`, so every
    // pre-existing test (whose fixtures don't) is unaffected.
    downloadMedia: async (fileId) => {
      downloadedFileIds.push(fileId);
      if (downloadMediaOverride) {
        return downloadMediaOverride(fileId);
      }
      return { dataBase64: `bytes-of-${fileId}`, mimeType: null };
    },
  });

  return {
    handleMessages,
    transport,
    identityRepository,
    conversationStateRepository,
    llmProvider,
    logEntries: entries,
    forwardedMessages,
    downloadedFileIds,
    advanceClock: (ms: number) => (clock += ms),
  };
}

function textMessage(customerId: string, messageId: string, text: string): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text, mediaType: null } };
}

function textMessageWithSender(
  customerId: string,
  messageId: string,
  text: string,
  sender: { senderDisplayName: string | null; senderProfileUrl: string | null }
): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text, mediaType: null, ...sender } };
}

/** Media with nothing downloadable behind it -- a sticker, or any platform whose adapter can't fetch attachments. */
function mediaMessage(customerId: string, messageId: string, mediaType: string): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text: null, mediaType } };
}

/** Media the adapter *can* fetch: a voice message, a photo, a document. `text` is the caption, if any. */
function attachmentMessage(
  customerId: string,
  messageId: string,
  attachment: { mediaType: string; mediaFileId: string; mediaMimeType?: string | null; text?: string | null }
): InboundMessage {
  return {
    customerId,
    messageId,
    sequence: 1,
    payload: {
      text: attachment.text ?? null,
      mediaType: attachment.mediaType,
      mediaFileId: attachment.mediaFileId,
      mediaMimeType: attachment.mediaMimeType ?? null,
    },
  };
}

function contactMessage(customerId: string, messageId: string, phoneNumber: string): InboundMessage {
  return {
    customerId,
    messageId,
    sequence: 1,
    payload: { text: `📞 ${phoneNumber}`, mediaType: "contact", sharedPhoneNumber: phoneNumber, sharedLocation: null },
  };
}

function locationMessage(customerId: string, messageId: string, latitude: number, longitude: number): InboundMessage {
  return {
    customerId,
    messageId,
    sequence: 1,
    payload: {
      text: `📍 ${latitude}, ${longitude}`,
      mediaType: "location",
      sharedPhoneNumber: null,
      sharedLocation: { latitude, longitude },
    },
  };
}

function businessMessage(customerId: string, messageId: string, text: string, businessConnectionId: string): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text, mediaType: null, businessConnectionId } };
}

test("a Telegram Business (Secretary Mode) message is answered through the exact same logic as an ordinary message, echoing its connection id on every reply", async () => {
  const { handleMessages, transport, llmProvider } = setup(["Да, миндальная мука есть в наличии."]);

  await handleMessages("telegram:50", [
    businessMessage("telegram:50", "50:1", "Здравствуйте, а миндальная мука есть в наличии?", "biz-conn-abc123"),
  ]);

  assert.equal(llmProvider.requests.length, 1, "a business message must reach the LLM exactly like an ordinary one");

  const typingCall = transport.calls.find((c) => c.method === "sendChatAction");
  assert.ok(typingCall && typingCall.method === "sendChatAction");
  assert.equal(typingCall.businessConnectionId, "biz-conn-abc123");

  const replyCall = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(replyCall && replyCall.method === "sendMessage");
  assert.equal(replyCall.businessConnectionId, "biz-conn-abc123", "the reply must go out via the same business connection the message arrived on");
});

test("an ordinary (non-Business) Telegram message never carries a business_connection_id", async () => {
  const { handleMessages, transport } = setup(["Almond flour is 150.000 per kg."]);

  await handleMessages("telegram:51", [textMessage("telegram:51", "m1", "How much is almond flour?")]);

  const replyCall = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(replyCall && replyCall.method === "sendMessage");
  assert.equal(replyCall.businessConnectionId, undefined);
});

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

test("when the sender has a resolved username and profile link, the manager notification names and links them instead of the bare customer id", async () => {
  const { handleMessages, transport } = setup([
    "Извините, скидки предоставляет только менеджер, я вас с ним свяжу.\n\n[ESCALATE]",
  ]);

  await handleMessages("telegram:33", [
    textMessageWithSender("telegram:33", "m1", "Дайте скидку 20%", {
      senderDisplayName: "@gulnara_k",
      senderProfileUrl: "https://t.me/gulnara_k",
    }),
  ]);

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage");
  assert.match(managerCall.text, /@gulnara_k/);
  assert.match(managerCall.text, /https:\/\/t\.me\/gulnara_k/);
});

test("when the sender has a name but no username (no link possible), the manager sees the name next to the raw customer id, not a fabricated link", async () => {
  const { handleMessages, transport } = setup([
    "Извините, скидки предоставляет только менеджер, я вас с ним свяжу.\n\n[ESCALATE]",
  ]);

  await handleMessages("telegram:34", [
    textMessageWithSender("telegram:34", "m1", "Дайте скидку 20%", {
      senderDisplayName: "Gulnara Khakimova",
      senderProfileUrl: null,
    }),
  ]);

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage");
  assert.match(managerCall.text, /Gulnara Khakimova/);
  assert.match(managerCall.text, /telegram:34/, "the raw id is still shown alongside a linkless name, so the manager isn't left with nothing to act on");
  assert.doesNotMatch(managerCall.text, /https:\/\/t\.me/, "no username means no real link exists -- must not invent one");
});

test("when the platform gave no sender info at all, the manager notification falls back to the bare customer id, exactly as before this feature existed", async () => {
  const { handleMessages, transport } = setup([
    "Извините, скидки предоставляет только менеджер, я вас с ним свяжу.\n\n[ESCALATE]",
  ]);

  await handleMessages("telegram:35", [textMessage("telegram:35", "m1", "Дайте скидку 20%")]);

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage");
  assert.match(managerCall.text, /Клиент: telegram:35/);
});

test("a reply asking for the phone number attaches a Telegram 'share contact' keyboard to the customer's message", async () => {
  const { handleMessages, transport } = setup(["Подскажите, пожалуйста, ваш номер телефона."]);

  await handleMessages("telegram:40", [textMessage("telegram:40", "m1", "Хочу сделать заказ")]);

  const customerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 40);
  assert.ok(customerCall && customerCall.method === "sendMessage");
  assert.deepEqual(customerCall.replyMarkup, {
    keyboard: [[{ text: "📞 Отправить номер", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
});

test("a reply asking for the delivery address attaches a Telegram 'share location' keyboard, and an ordinary reply attaches no keyboard", async () => {
  const { handleMessages, transport } = setup(["Стоимость миндальной муки 150.000 сум за кг.", "Уточните адрес доставки."]);

  await handleMessages("telegram:41", [textMessage("telegram:41", "m1", "Сколько стоит миндальная мука?")]);
  await handleMessages("telegram:41", [textMessage("telegram:41", "m2", "Беру 2кг")]);

  const customerCalls = transport.calls.filter((c) => c.method === "sendMessage" && c.chatId === 41);
  assert.equal(customerCalls.length, 2);
  if (customerCalls[0].method === "sendMessage") {
    assert.equal(customerCalls[0].replyMarkup, undefined, "a plain price answer needs no keyboard");
  }
  if (customerCalls[1].method === "sendMessage") {
    assert.deepEqual(customerCalls[1].replyMarkup, {
      keyboard: [[{ text: "📍 Отправить геолокацию", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
  }
});

test("a shared contact is not swallowed by the generic media fallback -- it reaches the LLM as a normal text turn", async () => {
  const { handleMessages, llmProvider } = setup(["Спасибо, ваш номер получен."]);

  await handleMessages("telegram:42", [contactMessage("telegram:42", "m1", "+998901234567")]);

  assert.equal(llmProvider.requests.length, 1, "a contact share must reach the LLM, not the deterministic media_fallback path");
  assert.match(llmProvider.requests[0].newUserMessage, /\+998901234567/);
});

test("a phone number shared several turns before handoff still reaches the manager notification when escalation finally happens", async () => {
  const { handleMessages, transport } = setup([
    "Спасибо, ваш номер получен.",
    "Оплата картой или наличными?",
    "Извините, я не могу подтвердить оплату -- передаю менеджеру.\n\n[ESCALATE]",
  ]);

  await handleMessages("telegram:43", [contactMessage("telegram:43", "m1", "+998901234567")]);
  await handleMessages("telegram:43", [textMessage("telegram:43", "m2", "2кг миндальной муки")]);
  await handleMessages("telegram:43", [textMessage("telegram:43", "m3", "Уже оплатил, проверьте")]);

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage");
  assert.match(managerCall.text, /Телефон: \+998901234567/, "the phone shared 2 turns earlier must still surface in the digest");
});

test("a shared location is forwarded natively to the manager (not described as text) once escalation happens, and the digest omits raw coordinates", async () => {
  const { handleMessages, transport, forwardedMessages } = setup([
    "Спасибо, локация получена.",
    "Извините, передаю вас менеджеру.\n\n[ESCALATE]",
  ]);

  await handleMessages("telegram:44", [locationMessage("telegram:44", "44:m1", 41.311081, 69.279737)]);
  await handleMessages("telegram:44", [textMessage("telegram:44", "m2", "Готово, что дальше?")]);

  assert.deepEqual(forwardedMessages, [{ sourceMessageId: "44:m1", recipientId: MANAGER_RECIPIENT_ID }]);

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage");
  assert.doesNotMatch(managerCall.text, /41\.311081/, "coordinates belong in the forwarded native message, not restated as text");
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

test("a voice message with no text reaches the LLM as an attachment, instead of being answered with 'send it as text'", async () => {
  const { handleMessages, transport, llmProvider, downloadedFileIds } = setup(["Да, миндальная мука есть в наличии."]);

  await handleMessages("telegram:50", [
    attachmentMessage("telegram:50", "50:m1", { mediaType: "voice", mediaFileId: "voice-abc", mediaMimeType: "audio/ogg" }),
  ]);

  assert.deepEqual(downloadedFileIds, ["voice-abc"]);
  assert.equal(llmProvider.requests.length, 1, "a voice message must reach the model, not the deterministic media fallback");
  assert.deepEqual(llmProvider.requests[0].attachments, [{ mimeType: "audio/ogg", dataBase64: "bytes-of-voice-abc" }]);

  const customerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 50);
  assert.ok(customerCall && customerCall.method === "sendMessage");
  assert.equal(customerCall.text, "Да, миндальная мука есть в наличии.");
});

test("a photo's caption is the customer's question -- it reaches the model as the turn's text, alongside the image", async () => {
  const { handleMessages, llmProvider } = setup(["Да, это наш миндаль."]);

  await handleMessages("telegram:51", [
    attachmentMessage("telegram:51", "51:m1", {
      mediaType: "photo",
      mediaFileId: "photo-abc",
      mediaMimeType: "image/jpeg",
      text: "это у вас есть?",
    }),
  ]);

  assert.equal(llmProvider.requests[0].newUserMessage, "это у вас есть?");
  assert.deepEqual(llmProvider.requests[0].attachments, [{ mimeType: "image/jpeg", dataBase64: "bytes-of-photo-abc" }]);
});

test("an uncaptioned attachment reaches the model as the file alone, with no text to compete with it", async () => {
  const { handleMessages, llmProvider } = setup(["Это наш миндаль, 150.000 сум за кг."]);

  await handleMessages("telegram:52", [
    attachmentMessage("telegram:52", "52:m1", { mediaType: "photo", mediaFileId: "photo-xyz", mediaMimeType: "image/jpeg" }),
  ]);

  // This started as the opposite assertion -- that a Russian description was
  // sent as the turn's text. In production that description was the only text
  // in the request, so a customer who spoke Uzbek got an Uzbek greeting
  // followed by a Russian price list: the model averaged the language it
  // heard with the language it read. The file has to arrive alone.
  assert.equal(llmProvider.requests[0].newUserMessage, "");
  assert.equal(llmProvider.requests[0].attachments?.length, 1);
});

test("the manager still gets a readable description of an uncaptioned voice message, even though the model got none", async () => {
  const { handleMessages, transport } = setup(["Передаю менеджеру.\n\n[ESCALATE]"]);

  await handleMessages("telegram:58", [
    attachmentMessage("telegram:58", "58:m1", { mediaType: "voice", mediaFileId: "voice-1", mediaMimeType: "audio/ogg" }),
  ]);

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage");
  assert.match(
    managerCall.text,
    /голосовое сообщение/,
    "staff read this one, so it stays Russian -- only the model is kept away from it"
  );
});

test("a file that can't be read escalates to a manager and forwards the original, rather than asking the customer to retype it", async () => {
  const { handleMessages, transport, llmProvider, forwardedMessages } = setup(["unused"], [], undefined, async () => {
    throw new Error("Telegram file is 48 MB, over the 15 MB limit this project can pass to the language model.");
  });

  await handleMessages("telegram:53", [
    attachmentMessage("telegram:53", "53:m1", { mediaType: "video", mediaFileId: "video-huge", mediaMimeType: "video/mp4" }),
  ]);

  assert.equal(llmProvider.requests.length, 0, "an unreadable file must never reach the model with the attachment silently missing");

  const customerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 53);
  assert.ok(customerCall && customerCall.method === "sendMessage");
  assert.equal(customerCall.text, fallbackMessage("mediaUnreadable", "ru"));

  const managerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 999999999);
  assert.ok(managerCall && managerCall.method === "sendMessage", "a manager must be told, since the customer was promised a human");
  assert.match(managerCall.text, /media_unreadable/);

  assert.deepEqual(
    forwardedMessages,
    [{ sourceMessageId: "53:m1", recipientId: MANAGER_RECIPIENT_ID }],
    "the manager needs the file itself -- a notification about a video they can't see is useless"
  );
});

test("a media message that escalates for an unrelated reason still forwards the file to the manager", async () => {
  const { handleMessages, forwardedMessages } = setup(["Передаю менеджеру.\n\n[ESCALATE]"]);

  await handleMessages("telegram:54", [
    attachmentMessage("telegram:54", "54:m1", { mediaType: "photo", mediaFileId: "photo-esc", text: "что это?" }),
  ]);

  assert.deepEqual(forwardedMessages, [{ sourceMessageId: "54:m1", recipientId: MANAGER_RECIPIENT_ID }]);
});

test("a burst of attachments is capped rather than sent whole, and what was dropped is logged instead of silently discarded", async () => {
  const { handleMessages, llmProvider, downloadedFileIds, logEntries } = setup(["Вижу, это наши продукты."]);

  await handleMessages(
    "telegram:55",
    ["a", "b", "c", "d", "e"].map((suffix) =>
      attachmentMessage("telegram:55", `55:${suffix}`, { mediaType: "photo", mediaFileId: `photo-${suffix}` })
    )
  );

  assert.equal(downloadedFileIds.length, 3, "downloading every photo of a five-photo burst costs the customer real waiting time");
  assert.equal(llmProvider.requests[0].attachments?.length, 3);
  assert.ok(
    logEntries.some((entry) => entry.event === "conversation.media_truncated"),
    "dropping input silently would read as 'the model saw everything' when it didn't"
  );
});

test("a sticker still gets the plain 'describe it in text' reply -- there is nothing in it worth a model call", async () => {
  const { handleMessages, transport, llmProvider, downloadedFileIds } = setup(["unused"]);

  await handleMessages("telegram:56", [mediaMessage("telegram:56", "56:m1", "sticker")]);

  assert.equal(downloadedFileIds.length, 0);
  assert.equal(llmProvider.requests.length, 0);
  const customerCall = transport.calls.find((c) => c.method === "sendMessage" && c.chatId === 56);
  assert.ok(customerCall && customerCall.method === "sendMessage");
  assert.equal(customerCall.text, fallbackMessage("mediaFallback", "ru"));
});

test("the message's own MIME type wins over whatever the file host's header claimed", async () => {
  const { handleMessages, llmProvider } = setup(["Понял."], [], undefined, async () => ({
    dataBase64: "bytes",
    mimeType: "application/octet-stream",
  }));

  await handleMessages("telegram:57", [
    attachmentMessage("telegram:57", "57:m1", { mediaType: "voice", mediaFileId: "voice-1", mediaMimeType: "audio/ogg" }),
  ]);

  assert.equal(llmProvider.requests[0].attachments?.[0].mimeType, "audio/ogg");
});

test("when the model is unreachable, a voice message's fallback follows the language the conversation has been in", async () => {
  // Answers turn one normally, then goes down -- so turn two has neither
  // customer text (a voice message has none) nor a fresh reply to read the
  // language from. Only the conversation's history is left.
  let calls = 0;
  const flakyProvider: LlmProvider = {
    generateReply: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: "Ha, bor. Pista pastasi 1 kg — 450.000 so'm.", truncated: false };
      }
      throw new Error("network is down");
    },
    checkHealth: async () => {},
  };

  const { handleMessages, transport } = setup([], [], flakyProvider);

  await handleMessages("telegram:59", [textMessage("telegram:59", "59:m1", "Pista pastasi bormi?")]);
  await handleMessages("telegram:59", [
    attachmentMessage("telegram:59", "59:m2", { mediaType: "voice", mediaFileId: "voice-1", mediaMimeType: "audio/ogg" }),
  ]);

  const customerReplies = transport.calls.filter((c) => c.method === "sendMessage" && c.chatId === 59);
  const lastReply = customerReplies[customerReplies.length - 1];
  assert.ok(lastReply && lastReply.method === "sendMessage");
  assert.equal(
    lastReply.text,
    fallbackMessage("technicalHiccup", "uz"),
    "a customer who has been speaking Uzbek must not get a Russian apology"
  );
});
