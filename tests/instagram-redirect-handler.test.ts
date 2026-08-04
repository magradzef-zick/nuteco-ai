import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstagramRedirectHandler } from "../src/engine/instagramRedirectHandler";
import type { InboundMessage } from "../src/engine/MessageDebouncer";
import { InstagramMessageSender } from "../src/adapters/instagram/InstagramMessageSender";
import { TelegramMessageSender } from "../src/adapters/telegram/TelegramMessageSender";
import { PlatformRoutingMessageSender } from "../src/adapters/PlatformRoutingMessageSender";
import { FakeInstagramTransport } from "./support/FakeInstagramTransport";
import { FakeTelegramTransport } from "./support/FakeTelegramTransport";
import { fakeLogger } from "./support/FakeLogger";

const MANAGER_CHAT_ID = "telegram:999999999";

function textMessage(customerId: string, messageId: string, text: string | null): InboundMessage {
  return { customerId, messageId, sequence: 1, payload: { text, mediaType: text === null ? "image" : null } };
}

function setup() {
  const instagramTransport = new FakeInstagramTransport();
  const telegramTransport = new FakeTelegramTransport();
  const messageSender = new PlatformRoutingMessageSender({
    instagram: new InstagramMessageSender({ transport: instagramTransport, sleep: async () => {} }),
    telegram: new TelegramMessageSender({ transport: telegramTransport, sleep: async () => {} }),
  });
  const { logger, entries: logEntries } = fakeLogger();
  const handle = createInstagramRedirectHandler({ messageSender, logger, managerNotificationRecipientId: MANAGER_CHAT_ID });
  return { handle, instagramTransport, telegramTransport, logEntries };
}

function customerReplyText(instagramTransport: FakeInstagramTransport): string {
  const call = instagramTransport.calls.find((c) => c.method === "sendMessage");
  assert.ok(call && call.method === "sendMessage", "expected exactly one sendMessage call to the customer");
  return call.text;
}

function managerNotificationText(telegramTransport: FakeTelegramTransport): string {
  const call = telegramTransport.calls.find((c) => c.method === "sendMessage");
  assert.ok(call && call.method === "sendMessage", "expected exactly one manager notification");
  return call.text;
}

test("a Russian message gets the Russian redirect template", async () => {
  const { handle, instagramTransport } = setup();
  await handle("instagram:1", [textMessage("instagram:1", "m1", "Здравствуйте, почём арахисовая паста?")]);

  const text = customerReplyText(instagramTransport);
  assert.match(text, /благодарим/);
  assert.match(text, /t\.me\/NutecoPremium/);
});

test("an Uzbek message gets the Uzbek redirect template, not a translation on the fly", async () => {
  const { handle, instagramTransport } = setup();
  await handle("instagram:2", [textMessage("instagram:2", "m2", "Assalomu alaykum, bodom uni qancha turadi?")]);

  const text = customerReplyText(instagramTransport);
  assert.match(text, /Assalomu alaykum/);
  assert.match(text, /t\.me\/NutecoPremium/);
});

test("an English message gets the English redirect template", async () => {
  const { handle, instagramTransport } = setup();
  await handle("instagram:3", [textMessage("instagram:3", "m3", "Hi, how much is the almond flour?")]);

  const text = customerReplyText(instagramTransport);
  assert.match(text, /thank you for your interest/i);
  assert.match(text, /t\.me\/NutecoPremium/);
});

test("a photo/voice message with no text defaults to Russian, same as the deterministic language detector's own default", async () => {
  const { handle, instagramTransport } = setup();
  await handle("instagram:4", [textMessage("instagram:4", "m4", null)]);

  const text = customerReplyText(instagramTransport);
  assert.match(text, /благодарим/);
});

test("sends exactly one reply for a multi-message batch, using the combined text to detect language", async () => {
  const { handle, instagramTransport } = setup();
  await handle("instagram:5", [
    textMessage("instagram:5", "m5a", "Salom"),
    textMessage("instagram:5", "m5b", "narxi qancha?"),
  ]);

  assert.equal(instagramTransport.calls.filter((c) => c.method === "sendMessage").length, 1);
});

test("never sends a typing indicator -- this is a fixed template, not a generated reply", async () => {
  const { handle, instagramTransport } = setup();
  await handle("instagram:6", [textMessage("instagram:6", "m6", "Hello")]);

  assert.deepEqual(instagramTransport.calls.map((c) => c.method), ["sendMessage"]);
});

test("a send failure to the customer is caught and logged, never thrown -- composition.ts's drainBatches relies on this to avoid a stuck queue", async () => {
  const instagramTransport = new FakeInstagramTransport();
  instagramTransport.sendMessage = async () => {
    throw new Error("simulated Graph API failure");
  };
  const telegramTransport = new FakeTelegramTransport();
  const messageSender = new PlatformRoutingMessageSender({
    instagram: new InstagramMessageSender({ transport: instagramTransport, sleep: async () => {} }),
    telegram: new TelegramMessageSender({ transport: telegramTransport, sleep: async () => {} }),
  });
  const { logger, entries: logEntries } = fakeLogger();
  const handle = createInstagramRedirectHandler({ messageSender, logger, managerNotificationRecipientId: MANAGER_CHAT_ID });

  await assert.doesNotReject(() => handle("instagram:7", [textMessage("instagram:7", "m7", "Hello")]));

  assert.ok(logEntries.some((e) => e.event === "instagram_redirect.send_failed" && e.fields.customerId === "instagram:7"));
  // The manager notification is independent of the customer send -- a
  // Graph API hiccup on the customer's side must not also swallow the
  // lead notification.
  assert.equal(telegramTransport.calls.length, 1);
});

test("every message also notifies the manager chat with the customer id and their actual message", async () => {
  const { handle, telegramTransport } = setup();
  await handle("instagram:8", [textMessage("instagram:8", "m8", "Здравствуйте, а масло холодного отжима делаете?")]);

  const text = managerNotificationText(telegramTransport);
  assert.match(text, /instagram:8/);
  assert.match(text, /масло холодного отжима/);
});

test("a photo/voice message with no text still notifies the manager, flagged as having no text to quote", async () => {
  const { handle, telegramTransport } = setup();
  await handle("instagram:9", [textMessage("instagram:9", "m9", null)]);

  const text = managerNotificationText(telegramTransport);
  assert.match(text, /instagram:9/);
  assert.match(text, /без текста/);
});

test("a manager-notification send failure is caught and logged, and does not prevent the customer's own reply", async () => {
  const instagramTransport = new FakeInstagramTransport();
  const telegramTransport = new FakeTelegramTransport();
  telegramTransport.sendMessage = async () => {
    throw new Error("simulated Telegram API failure");
  };
  const messageSender = new PlatformRoutingMessageSender({
    instagram: new InstagramMessageSender({ transport: instagramTransport, sleep: async () => {} }),
    telegram: new TelegramMessageSender({ transport: telegramTransport, sleep: async () => {} }),
  });
  const { logger, entries: logEntries } = fakeLogger();
  const handle = createInstagramRedirectHandler({ messageSender, logger, managerNotificationRecipientId: MANAGER_CHAT_ID });

  await assert.doesNotReject(() => handle("instagram:10", [textMessage("instagram:10", "m10", "Hello")]));

  assert.equal(instagramTransport.calls.filter((c) => c.method === "sendMessage").length, 1, "the customer still gets their reply");
  assert.ok(logEntries.some((e) => e.event === "manager_notification.failed" && e.fields.customerId === "instagram:10"));
});
