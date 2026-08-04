import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstagramRedirectHandler } from "../src/engine/instagramRedirectHandler";
import type { InboundMessage } from "../src/engine/MessageDebouncer";
import { InstagramMessageSender } from "../src/adapters/instagram/InstagramMessageSender";
import { FakeInstagramTransport } from "./support/FakeInstagramTransport";
import { fakeLogger } from "./support/FakeLogger";

function textMessage(customerId: string, messageId: string, text: string | null): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text, mediaType: text === null ? "image" : null } };
}

function setup() {
  const transport = new FakeInstagramTransport();
  const messageSender = new InstagramMessageSender({ transport, sleep: async () => {} });
  const { logger, entries: logEntries } = fakeLogger();
  const handle = createInstagramRedirectHandler({ messageSender, logger });
  return { handle, transport, logEntries };
}

function sentText(transport: FakeInstagramTransport): string {
  const call = transport.calls.find((c) => c.method === "sendMessage");
  assert.ok(call && call.method === "sendMessage", "expected exactly one sendMessage call");
  return call.text;
}

test("a Russian message gets the Russian redirect template", async () => {
  const { handle, transport } = setup();
  await handle("instagram:1", [textMessage("instagram:1", "m1", "Здравствуйте, почём арахисовая паста?")]);

  const text = sentText(transport);
  assert.match(text, /благодарим/);
  assert.match(text, /t\.me\/NutecoPremium/);
});

test("an Uzbek message gets the Uzbek redirect template, not a translation on the fly", async () => {
  const { handle, transport } = setup();
  await handle("instagram:2", [textMessage("instagram:2", "m2", "Assalomu alaykum, bodom uni qancha turadi?")]);

  const text = sentText(transport);
  assert.match(text, /Assalomu alaykum/);
  assert.match(text, /t\.me\/NutecoPremium/);
});

test("an English message gets the English redirect template", async () => {
  const { handle, transport } = setup();
  await handle("instagram:3", [textMessage("instagram:3", "m3", "Hi, how much is the almond flour?")]);

  const text = sentText(transport);
  assert.match(text, /thank you for your interest/i);
  assert.match(text, /t\.me\/NutecoPremium/);
});

test("a photo/voice message with no text defaults to Russian, same as the deterministic language detector's own default", async () => {
  const { handle, transport } = setup();
  await handle("instagram:4", [textMessage("instagram:4", "m4", null)]);

  const text = sentText(transport);
  assert.match(text, /благодарим/);
});

test("sends exactly one reply for a multi-message batch, using the combined text to detect language", async () => {
  const { handle, transport } = setup();
  await handle("instagram:5", [
    textMessage("instagram:5", "m5a", "Salom"),
    textMessage("instagram:5", "m5b", "narxi qancha?"),
  ]);

  assert.equal(transport.calls.filter((c) => c.method === "sendMessage").length, 1);
});

test("never sends a typing indicator -- this is a fixed template, not a generated reply", async () => {
  const { handle, transport } = setup();
  await handle("instagram:6", [textMessage("instagram:6", "m6", "Hello")]);

  assert.deepEqual(transport.calls.map((c) => c.method), ["sendMessage"]);
});

test("a send failure is caught and logged, never thrown -- composition.ts's drainBatches relies on this to avoid a stuck queue", async () => {
  const transport = new FakeInstagramTransport();
  transport.sendMessage = async () => {
    throw new Error("simulated Graph API failure");
  };
  const messageSender = new InstagramMessageSender({ transport, sleep: async () => {} });
  const { logger, entries: logEntries } = fakeLogger();
  const handle = createInstagramRedirectHandler({ messageSender, logger });

  await assert.doesNotReject(() => handle("instagram:7", [textMessage("instagram:7", "m7", "Hello")]));

  assert.ok(logEntries.some((e) => e.event === "instagram_redirect.send_failed" && e.fields.customerId === "instagram:7"));
});
