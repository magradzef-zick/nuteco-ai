import { test } from "node:test";
import assert from "node:assert/strict";
import { InstagramMessageSender, parseInstagramRecipientId } from "../src/adapters/instagram/InstagramMessageSender";
import { FakeInstagramTransport } from "./support/FakeInstagramTransport";

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

test("parseInstagramRecipientId extracts the recipient id as a string", () => {
  assert.equal(parseInstagramRecipientId("instagram:123456789012345"), "123456789012345");
});

test("parseInstagramRecipientId throws clearly on a malformed customer id", () => {
  assert.throws(() => parseInstagramRecipientId("telegram:555"), /not a valid Instagram customer ID/);
  assert.throws(() => parseInstagramRecipientId("instagram:abc"), /not a valid Instagram customer ID/);
});

test("sendTyping shows the typing_on sender action on the correct recipient", async () => {
  const transport = new FakeInstagramTransport();
  const sender = new InstagramMessageSender({ transport });

  await sender.sendTyping("instagram:555");

  assert.deepEqual(transport.calls, [{ method: "sendSenderAction", recipientId: "555", action: "typing_on" }]);
});

test("sendReply sends each message in order", async () => {
  const transport = new FakeInstagramTransport();
  const { sleep } = recordingSleep();
  const sender = new InstagramMessageSender({ transport, sleep });

  await sender.sendReply("instagram:555", ["First part.", "Second part."]);

  assert.deepEqual(transport.calls, [
    { method: "sendMessage", recipientId: "555", text: "First part." },
    { method: "sendMessage", recipientId: "555", text: "Second part." },
  ]);
});

test("sendReply pauses between messages but not before the first one", async () => {
  const transport = new FakeInstagramTransport();
  const { sleep, delays } = recordingSleep();
  const sender = new InstagramMessageSender({ transport, sleep, interMessageDelayMs: 350 });

  await sender.sendReply("instagram:555", ["a", "b", "c"]);

  assert.deepEqual(delays, [350, 350], "2 pauses for 3 messages, none before the first");
});

test("a single message under the length limit is sent unmodified", async () => {
  const transport = new FakeInstagramTransport();
  const sender = new InstagramMessageSender({ transport });

  const normalMessage = "x".repeat(1000);
  await sender.sendReply("instagram:555", [normalMessage]);

  assert.equal(transport.calls.length, 1);
});

test("a message exceeding Instagram's length limit is split, not rejected", async () => {
  const transport = new FakeInstagramTransport();
  const { sleep } = recordingSleep();
  const sender = new InstagramMessageSender({ transport, sleep });

  const overLong = "x".repeat(1000) + "y".repeat(10);
  await sender.sendReply("instagram:555", [overLong]);

  assert.equal(transport.calls.length, 2, "should split into exactly 2 sends");
  const sentTexts = transport.calls
    .filter((call): call is Extract<typeof call, { method: "sendMessage" }> => call.method === "sendMessage")
    .map((call) => call.text);
  assert.equal(sentTexts[0].length, 1000);
  assert.equal(sentTexts[1], "y".repeat(10));
  assert.equal(sentTexts.join(""), overLong, "no content should be lost by splitting");
});
