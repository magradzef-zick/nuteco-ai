import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstagramWebhookEvent, type NormalizedInstagramMessage } from "../src/adapters/instagram/parseWebhookEvent";
import type { InboundMessage } from "../src/engine/MessageDebouncer";

function webhookPayload(messagingEvents: Record<string, unknown>[]) {
  return {
    object: "instagram",
    entry: [{ id: "17841400000000000", time: 1_700_000_000_000, messaging: messagingEvents }],
  };
}

function textMessagingEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: { id: "123456789012345" },
    recipient: { id: "17841400000000000" },
    timestamp: 1_700_000_000_123,
    message: { mid: "mid.abc123", text: "Hello, what's the price of almond flour?" },
    ...overrides,
  };
}

test("parses a plain text message into an InboundMessage", () => {
  const results = parseInstagramWebhookEvent(webhookPayload([textMessagingEvent()]));

  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.kind, "message");
  if (result.kind !== "message") return;

  const message: InboundMessage = result.message;
  assert.equal(message.customerId, "instagram:123456789012345");
  assert.equal(message.messageId, "123456789012345:mid.abc123");
  assert.equal(message.sequence, 1_700_000_000_123);

  const payload = message.payload as NormalizedInstagramMessage;
  assert.equal(payload.text, "Hello, what's the price of almond flour?");
  assert.equal(payload.mediaType, null);
  assert.equal(payload.senderId, "123456789012345");
  assert.equal(payload.instagramMessageId, "mid.abc123");
});

test("a message the page itself sent (is_echo) is treated as unsupported, not a customer message", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([textMessagingEvent({ message: { mid: "mid.echo1", text: "Our reply", is_echo: true } })])
  );

  assert.deepEqual(results, [{ kind: "unsupported", updateType: "message_echo" }]);
});

test("a tap-to-react on our Story (no text, no attachment) is treated as unsupported, not a customer message", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([
      textMessagingEvent({ message: { mid: "mid.reaction1", reply_to: { story: { id: "17800", url: "https://..." } } } }),
    ])
  );

  assert.deepEqual(results, [{ kind: "unsupported", updateType: "contentless_message" }]);
});

test("a message with neither text nor attachments is unsupported even without a reply_to (belt and suspenders)", () => {
  const results = parseInstagramWebhookEvent(webhookPayload([textMessagingEvent({ message: { mid: "mid.empty1" } })]));

  assert.deepEqual(results, [{ kind: "unsupported", updateType: "contentless_message" }]);
});

test("a Story reaction whose text is only the reaction emoji is treated as unsupported, not a customer message", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([
      textMessagingEvent({ message: { mid: "mid.reaction2", text: "😢", reply_to: { story: { id: "17800" } } } }),
    ])
  );

  // Confirmed in production: this used to reach the model as a real
  // message and get a real (English, off-hours-escalation) reply to a
  // customer who never asked anything.
  assert.deepEqual(results, [{ kind: "unsupported", updateType: "story_reaction" }]);
});

test("a multi-codepoint emoji reaction (skin tone, ZWJ sequence) is still recognized as bare", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([
      textMessagingEvent({ message: { mid: "mid.reaction3", text: "👍🏽", reply_to: { story: { id: "17800" } } } }),
    ])
  );

  assert.deepEqual(results, [{ kind: "unsupported", updateType: "story_reaction" }]);
});

test("an emoji reaction with NO reply_to (an ordinary emoji-only DM) is answered normally, not skipped", () => {
  const results = parseInstagramWebhookEvent(webhookPayload([textMessagingEvent({ message: { mid: "mid.emoji1", text: "😢" } })]));

  assert.equal(results[0].kind, "message");
});

test("a real story reply with actual text is answered normally, not treated as a bare reaction", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([
      textMessagingEvent({
        message: { mid: "mid.storyreply1", text: "А сколько стоит?", reply_to: { story: { id: "17800" } } },
      }),
    ])
  );

  assert.equal(results[0].kind, "message");
  if (results[0].kind !== "message") return;
  assert.equal((results[0].message.payload as NormalizedInstagramMessage).text, "А сколько стоит?");
});

const mediaCases: Array<[string, string]> = [
  ["image", "image"],
  ["audio", "audio"],
  ["video", "video"],
  ["file", "file"],
  ["story_mention", "story_mention"],
  ["share", "share"],
];

for (const [attachmentType, expectedMediaType] of mediaCases) {
  test(`detects ${attachmentType} attachments and reports no text`, () => {
    const results = parseInstagramWebhookEvent(
      webhookPayload([
        textMessagingEvent({ message: { mid: "mid.media1", attachments: [{ type: attachmentType }] } }),
      ])
    );

    assert.equal(results[0].kind, "message");
    if (results[0].kind !== "message") return;
    const payload = results[0].message.payload as NormalizedInstagramMessage;
    assert.equal(payload.mediaType, expectedMediaType);
    assert.equal(payload.text, null);
  });
}

test("an unrecognized attachment type is normalized to 'other' rather than dropped", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([textMessagingEvent({ message: { mid: "mid.media2", attachments: [{ type: "some_new_type" }] } })])
  );

  assert.equal(results[0].kind, "message");
  if (results[0].kind !== "message") return;
  assert.equal((results[0].message.payload as NormalizedInstagramMessage).mediaType, "other");
});

test("reports a known-but-unhandled event type explicitly instead of silently dropping it", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([{ sender: { id: "1" }, recipient: { id: "2" }, timestamp: 1, read: { mid: "mid.read1" } }])
  );

  assert.deepEqual(results, [{ kind: "unsupported", updateType: "read" }]);
});

test("falls back to 'unknown' for a genuinely unrecognized messaging event shape", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([{ sender: { id: "1" }, recipient: { id: "2" }, timestamp: 1, something_new_from_meta: {} }])
  );

  assert.deepEqual(results, [{ kind: "unsupported", updateType: "unknown" }]);
});

test("a single webhook POST batching multiple messaging events returns one result per event", () => {
  const results = parseInstagramWebhookEvent(
    webhookPayload([
      textMessagingEvent({ sender: { id: "111" }, message: { mid: "mid.1", text: "First" } }),
      textMessagingEvent({ sender: { id: "222" }, message: { mid: "mid.2", text: "Second" } }),
    ])
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].kind, "message");
  assert.equal(results[1].kind, "message");
  if (results[0].kind !== "message" || results[1].kind !== "message") return;
  assert.equal(results[0].message.customerId, "instagram:111");
  assert.equal(results[1].message.customerId, "instagram:222");
});

test("a payload with no entries at all returns an empty array, not an error", () => {
  assert.deepEqual(parseInstagramWebhookEvent({ object: "instagram", entry: [] }), []);
  assert.deepEqual(parseInstagramWebhookEvent({}), []);
});
