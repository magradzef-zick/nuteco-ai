import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdate, parseTelegramMessageId, type NormalizedTelegramMessage } from "../src/adapters/telegram/parseUpdate";
import type { InboundMessage } from "../src/engine/MessageDebouncer";

function textMessageUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      date: 1_700_000_000,
      chat: { id: 555 },
      from: { id: 555 },
      text: "Hello, what's the price of almond flour?",
      ...overrides,
    },
  };
}

test("parses a plain text message into an InboundMessage", () => {
  const result = parseUpdate(textMessageUpdate());

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;

  const message: InboundMessage = result.message;
  assert.equal(message.customerId, "telegram:555");
  assert.equal(message.messageId, "555:42");
  assert.equal(message.sequence, 42);

  const payload = message.payload as NormalizedTelegramMessage;
  assert.equal(payload.text, "Hello, what's the price of almond flour?");
  assert.equal(payload.mediaType, null);
  assert.equal(payload.isEdited, false);
  assert.equal(payload.chatId, 555);
});

test("a sender with a public username gets a clickable t.me profile link", () => {
  const result = parseUpdate(textMessageUpdate({ from: { id: 555, username: "gulnara_k", first_name: "Gulnara" } }));

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  const payload = result.message.payload as NormalizedTelegramMessage;

  // The username wins over the name -- it's the only one that yields a
  // real, working link.
  assert.equal(payload.senderDisplayName, "@gulnara_k");
  assert.equal(payload.senderProfileUrl, "https://t.me/gulnara_k");
});

test("a sender with no username falls back to their name, with no link -- Telegram usernames are optional, not every real user has one", () => {
  const result = parseUpdate(textMessageUpdate({ from: { id: 555, first_name: "Gulnara", last_name: "Khakimova" } }));

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  const payload = result.message.payload as NormalizedTelegramMessage;

  assert.equal(payload.senderDisplayName, "Gulnara Khakimova");
  assert.equal(payload.senderProfileUrl, null, "no username means no reliable way to build a clickable link");
});

test("a sender with neither a username nor a name yields no display info at all, not an empty string", () => {
  const result = parseUpdate(textMessageUpdate({ from: { id: 555 } }));

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  const payload = result.message.payload as NormalizedTelegramMessage;

  assert.equal(payload.senderDisplayName, null);
  assert.equal(payload.senderProfileUrl, null);
});

test("parses an edited message, flags it, and uses edit_date as the timestamp", () => {
  const update = {
    update_id: 2,
    edited_message: {
      message_id: 42,
      date: 1_700_000_000,
      edit_date: 1_700_000_050,
      chat: { id: 555 },
      text: "Corrected question",
    },
  };

  const result = parseUpdate(update);
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;

  const payload = result.message.payload as NormalizedTelegramMessage;
  assert.equal(payload.isEdited, true);
  assert.equal(payload.timestamp, 1_700_000_050);
  assert.equal(
    result.message.messageId,
    "555:42",
    "an edit should use the same message key as the original so the debouncer can treat it consistently"
  );
});

const mediaCases: Array<[string, Record<string, unknown>, string]> = [
  ["photo", { photo: [{ file_id: "abc" }] }, "photo"],
  ["voice", { voice: { duration: 3 } }, "voice"],
  ["video_note", { video_note: { duration: 5 } }, "video_note"],
  ["video", { video: { duration: 10 } }, "video"],
  ["sticker", { sticker: { emoji: "😀" } }, "sticker"],
  ["document", { document: { file_name: "price-list.pdf" } }, "document"],
];

for (const [label, mediaField, expectedType] of mediaCases) {
  test(`detects ${label} messages and reports no text`, () => {
    const update = textMessageUpdate({ text: undefined, ...mediaField });
    const result = parseUpdate(update);

    assert.equal(result.kind, "message");
    if (result.kind !== "message") return;

    const payload = result.message.payload as NormalizedTelegramMessage;
    assert.equal(payload.mediaType, expectedType);
    assert.equal(payload.text, null);
  });
}

test("a shared contact is surfaced as text (so the order-collection flow and hallucination guardrail can read it like any other message) and its raw phone number is kept structurally too", () => {
  const update = textMessageUpdate({ text: undefined, contact: { phone_number: "+998901234567" } });
  const result = parseUpdate(update);

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;

  const payload = result.message.payload as NormalizedTelegramMessage;
  assert.equal(payload.mediaType, "contact");
  assert.equal(payload.text, "📞 +998901234567");
  assert.equal(payload.sharedPhoneNumber, "+998901234567");
  assert.equal(payload.sharedLocation, null);
});

test("a shared location is surfaced as text, and its raw coordinates are kept structurally too (for forwarding the original message natively)", () => {
  const update = textMessageUpdate({ text: undefined, location: { latitude: 41.311081, longitude: 69.279737 } });
  const result = parseUpdate(update);

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;

  const payload = result.message.payload as NormalizedTelegramMessage;
  assert.equal(payload.mediaType, "location");
  assert.equal(payload.text, "📍 41.311081, 69.279737");
  assert.deepEqual(payload.sharedLocation, { latitude: 41.311081, longitude: 69.279737 });
  assert.equal(payload.sharedPhoneNumber, null);
});

test("a sticker sent alongside no text is not treated as an empty/broken message", () => {
  const update = textMessageUpdate({ text: undefined, sticker: { emoji: "👍" } });
  const result = parseUpdate(update);

  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;
  assert.equal((result.message.payload as NormalizedTelegramMessage).mediaType, "sticker");
});

test("reports a known-but-unhandled update type explicitly instead of silently dropping it", () => {
  const result = parseUpdate({
    update_id: 3,
    callback_query: { id: "cb1", data: "some_button" },
  });

  assert.deepEqual(result, { kind: "unsupported", updateType: "callback_query" });
});

test("falls back to 'unknown' for a genuinely unrecognized update shape", () => {
  const result = parseUpdate({ update_id: 4, something_new_from_telegram: {} });
  assert.deepEqual(result, { kind: "unsupported", updateType: "unknown" });
});

test("parseTelegramMessageId is the exact inverse of the messageId parseUpdate constructs, including a negative group-chat id", () => {
  assert.deepEqual(parseTelegramMessageId("555:42"), { chatId: 555, telegramMessageId: 42 });
  assert.deepEqual(parseTelegramMessageId("-100123456789:7"), { chatId: -100123456789, telegramMessageId: 7 });
});

test("parseTelegramMessageId throws clearly on a malformed id", () => {
  assert.throws(() => parseTelegramMessageId("not-a-message-id"), /not a valid Telegram message id/);
});
