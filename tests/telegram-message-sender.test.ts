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

test("sendTyping forwards businessConnectionId to the transport (Telegram Business / Secretary Mode)", async () => {
  const transport = new FakeTelegramTransport();
  const sender = new TelegramMessageSender({ transport });

  await sender.sendTyping("telegram:555", { businessConnectionId: "biz-conn-abc123" });

  assert.deepEqual(transport.calls, [
    { method: "sendChatAction", chatId: 555, action: "typing", businessConnectionId: "biz-conn-abc123" },
  ]);
});

test("sendReply forwards businessConnectionId to every chunk, not just the last", async () => {
  const transport = new FakeTelegramTransport();
  const { sleep } = recordingSleep();
  const sender = new TelegramMessageSender({ transport, sleep });

  await sender.sendReply("telegram:555", ["First part.", "Second part."], { businessConnectionId: "biz-conn-abc123" });

  const sendCalls = transport.calls.filter((c) => c.method === "sendMessage");
  assert.equal(sendCalls.length, 2);
  for (const call of sendCalls) {
    if (call.method === "sendMessage") {
      assert.equal(call.businessConnectionId, "biz-conn-abc123");
    }
  }
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

test("neither option set attaches no keyboard at all", async () => {
  const transport = new FakeTelegramTransport();
  const sender = new TelegramMessageSender({ transport });

  await sender.sendReply("telegram:555", ["Обычный ответ."], {});

  assert.equal(transport.calls[0].method, "sendMessage");
  assert.equal((transport.calls[0] as { replyMarkup?: unknown }).replyMarkup, undefined);
});

test("requestContact attaches a one-tap 'share your contact' keyboard to the last message", async () => {
  const transport = new FakeTelegramTransport();
  const { sleep } = recordingSleep();
  const sender = new TelegramMessageSender({ transport, sleep });

  await sender.sendReply("telegram:555", ["Первая часть.", "Оставьте, пожалуйста, номер."], { requestContact: true });

  assert.equal((transport.calls[0] as { replyMarkup?: unknown }).replyMarkup, undefined, "not on the first bubble");
  assert.deepEqual((transport.calls[1] as { replyMarkup?: unknown }).replyMarkup, {
    keyboard: [[{ text: "📞 Отправить номер", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
});

test("requestLocation attaches a one-tap 'share your location' keyboard", async () => {
  const transport = new FakeTelegramTransport();
  const sender = new TelegramMessageSender({ transport });

  await sender.sendReply("telegram:555", ["Уточните адрес доставки."], { requestLocation: true });

  assert.deepEqual((transport.calls[0] as { replyMarkup?: unknown }).replyMarkup, {
    keyboard: [[{ text: "📍 Отправить геолокацию", request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
});

test("both options set shows both buttons in one keyboard", async () => {
  const transport = new FakeTelegramTransport();
  const sender = new TelegramMessageSender({ transport });

  await sender.sendReply("telegram:555", ["Локацию и номер получателя, пожалуйста."], {
    requestContact: true,
    requestLocation: true,
  });

  assert.deepEqual((transport.calls[0] as { replyMarkup?: unknown }).replyMarkup, {
    keyboard: [
      [{ text: "📞 Отправить номер", request_contact: true }],
      [{ text: "📍 Отправить геолокацию", request_location: true }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
});
