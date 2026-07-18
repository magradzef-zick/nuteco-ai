import { test } from "node:test";
import assert from "node:assert/strict";
import { PlatformRoutingMessageSender } from "../src/adapters/PlatformRoutingMessageSender";
import { TelegramMessageSender } from "../src/adapters/telegram/TelegramMessageSender";
import { InstagramMessageSender } from "../src/adapters/instagram/InstagramMessageSender";
import { FakeTelegramTransport } from "./support/FakeTelegramTransport";
import { FakeInstagramTransport } from "./support/FakeInstagramTransport";

test("routes a telegram: customerId to the Telegram sender", async () => {
  const telegramTransport = new FakeTelegramTransport();
  const instagramTransport = new FakeInstagramTransport();
  const sender = new PlatformRoutingMessageSender({
    telegram: new TelegramMessageSender({ transport: telegramTransport, sleep: async () => {} }),
    instagram: new InstagramMessageSender({ transport: instagramTransport, sleep: async () => {} }),
  });

  await sender.sendReply("telegram:555", ["hi"]);

  assert.equal(telegramTransport.calls.length, 1);
  assert.equal(instagramTransport.calls.length, 0);
});

test("routes an instagram: customerId to the Instagram sender", async () => {
  const telegramTransport = new FakeTelegramTransport();
  const instagramTransport = new FakeInstagramTransport();
  const sender = new PlatformRoutingMessageSender({
    telegram: new TelegramMessageSender({ transport: telegramTransport, sleep: async () => {} }),
    instagram: new InstagramMessageSender({ transport: instagramTransport, sleep: async () => {} }),
  });

  await sender.sendReply("instagram:123456", ["hi"]);

  assert.equal(instagramTransport.calls.length, 1);
  assert.equal(telegramTransport.calls.length, 0);
});

test("sendTyping routes the same way as sendReply", async () => {
  const instagramTransport = new FakeInstagramTransport();
  const sender = new PlatformRoutingMessageSender({
    instagram: new InstagramMessageSender({ transport: instagramTransport, sleep: async () => {} }),
  });

  await sender.sendTyping("instagram:123456");

  assert.deepEqual(instagramTransport.calls, [{ method: "sendSenderAction", recipientId: "123456", action: "typing_on" }]);
});

test("throws a clear error for a platform with no registered sender", async () => {
  const sender = new PlatformRoutingMessageSender({
    telegram: new TelegramMessageSender({ transport: new FakeTelegramTransport() }),
  });

  await assert.rejects(() => sender.sendReply("whatsapp:555", ["hi"]), /no registered MessageSender for platform "whatsapp"/);
});
