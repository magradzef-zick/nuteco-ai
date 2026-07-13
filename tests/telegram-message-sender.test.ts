import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramMessageSender, parseTelegramChatId } from "../src/adapters/telegram/TelegramMessageSender";
import { FakeTelegramTransport } from "./support/FakeTelegramTransport";

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

test("parseTelegramChatId extracts the numeric chat id", () => {
  assert.equal(parseTelegramChatId("telegram:555"), 555);
  assert.equal(parseTelegramChatId("telegram:-100123456"), -100123456);
});

test("parseTelegramChatId throws clearly on a malformed customer id", () => {
  assert.throws(() => parseTelegramChatId("instagram:555"), /not a valid Telegram customer ID/);
  assert.throws(() => parseTelegramChatId("telegram:abc"), /not a valid Telegram customer ID/);
});

test("sendTyping shows the typing indicator on the correct chat", async () => {
  const transport = new FakeTelegramTransport();
  const sender = new TelegramMessageSender({ transport });

  await sender.sendTyping("telegram:555");

  assert.deepEqual(transport.calls, [{ method: "sendChatAction", chatId: 555, action: "typing" }]);
});

test("sendReply sends each message in order", async () => {
  const transport = new FakeTelegramTransport();
  const { sleep } = recordingSleep();
  const sender = new TelegramMessageSender({ transport, sleep });

  await sender.sendReply("telegram:555", ["First part.", "Second part."]);

  assert.deepEqual(transport.calls, [
    { method: "sendMessage", chatId: 555, text: "First part." },
    { method: "sendMessage", chatId: 555, text: "Second part." },
  ]);
});

test("sendReply pauses between messages but not before the first one", async () => {
  const transport = new FakeTelegramTransport();
  const { sleep, delays } = recordingSleep();
  const sender = new TelegramMessageSender({ transport, sleep, interMessageDelayMs: 350 });

  await sender.sendReply("telegram:555", ["a", "b", "c"]);

  assert.deepEqual(delays, [350, 350], "2 pauses for 3 messages, none before the first");
});

test("a single message under the length limit is sent unmodified", async () => {
  const transport = new FakeTelegramTransport();
  const sender = new TelegramMessageSender({ transport });

  const normalMessage = "x".repeat(4096);
  await sender.sendReply("telegram:555", [normalMessage]);

  assert.equal(transport.calls.length, 1);
});

test("a message exceeding Telegram's length limit is split, not rejected", async () => {
  const transport = new FakeTelegramTransport();
  const { sleep } = recordingSleep();
  const sender = new TelegramMessageSender({ transport, sleep });

  const overLong = "x".repeat(4096) + "y".repeat(10);
  await sender.sendReply("telegram:555", [overLong]);

  assert.equal(transport.calls.length, 2, "should split into exactly 2 sends");
  const sentTexts = transport.calls
    .filter((call): call is Extract<typeof call, { method: "sendMessage" }> => call.method === "sendMessage")
    .map((call) => call.text);
  assert.equal(sentTexts[0].length, 4096);
  assert.equal(sentTexts[1], "y".repeat(10));
  assert.equal(sentTexts.join(""), overLong, "no content should be lost by splitting");
});
