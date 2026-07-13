import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdate, type NormalizedTelegramMessage } from "../src/adapters/telegram/parseUpdate";
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
  ["location", { location: { latitude: 1, longitude: 2 } }, "location"],
  ["contact", { contact: { phone_number: "+998" } }, "contact"],
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
