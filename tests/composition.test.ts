import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageDebouncer } from "../src/engine/MessageDebouncer";
import { handleIncomingTelegramUpdate } from "../src/composition";
import { fakeLogger } from "./support/FakeLogger";

function textUpdate(updateId: number, messageId: number, chatId: number, text: string) {
  return {
    update_id: updateId,
    message: { message_id: messageId, date: 1_700_000_000, chat: { id: chatId }, text },
  };
}

/**
 * Regression coverage: previously, if `handleMessages` threw for any
 * reason, `deps.debouncer.complete(...)`
 * was never called for that batch -- and per MessageDebouncer's own
 * protocol, only `complete()` clears a customer's "in flight" flag. Every
 * subsequent message from that exact customer was then silently queued
 * forever and never processed again, with no way to recover short of
 * restarting the whole process. These tests prove the customer's queue
 * always returns to a healthy, unstuck state, even when `handleMessages`
 * throws -- which, combined with ConversationEngine no longer throwing for
 * its own expected failure mode (an unreachable LLM), is what actually
 * fixes the deadlock end-to-end.
 */
test("a customer is NOT permanently locked out after handleMessages throws for one of their messages", async () => {
  const debouncer = new MessageDebouncer();
  const { logger, entries } = fakeLogger();
  const handledCalls: string[][] = [];

  const handleMessages = async (_customerId: string, messages: { messageId: string }[]) => {
    handledCalls.push(messages.map((m) => m.messageId));
    throw new Error("simulated unexpected failure");
  };

  await handleIncomingTelegramUpdate(textUpdate(1, 100, 555, "first message"), { debouncer, handleMessages, logger });

  // The failure was logged distinctly, not silently swallowed.
  assert.ok(entries.some((e) => e.event === "conversation.unhandled_error" && e.fields.customerId === "telegram:555"));

  // The customer's next message must still be processed normally -- not
  // silently queued forever because the debouncer thinks a batch is still
  // in flight.
  await handleIncomingTelegramUpdate(textUpdate(2, 101, 555, "second message"), { debouncer, handleMessages, logger });

  assert.deepEqual(
    handledCalls,
    [["555:100"], ["555:101"]],
    "both messages must have reached handleMessages, not just the first"
  );
});

test("a message that queued up while the failing batch was in flight is not left stuck either", async () => {
  const debouncer = new MessageDebouncer();
  const { logger, entries } = fakeLogger();
  let releaseFirstCall: (() => void) | undefined;
  const handledCalls: string[][] = [];

  const handleMessages = async (_customerId: string, messages: { messageId: string }[]) => {
    handledCalls.push(messages.map((m) => m.messageId));
    if (handledCalls.length === 1) {
      // Block until the test admits a second message while this first
      // batch is still "in flight", then fail -- reproducing the real
      // race: more messages arrive while a batch that will ultimately
      // throw is still being processed.
      await new Promise<void>((resolve) => {
        releaseFirstCall = resolve;
      });
      throw new Error("simulated unexpected failure");
    }
  };

  const firstUpdatePromise = handleIncomingTelegramUpdate(textUpdate(1, 200, 777, "first"), {
    debouncer,
    handleMessages,
    logger,
  });

  // Give the first call a chance to start and register its release hook.
  await new Promise((resolve) => setImmediate(resolve));
  await handleIncomingTelegramUpdate(textUpdate(2, 201, 777, "queued while first was in flight"), {
    debouncer,
    handleMessages,
    logger,
  });

  assert.ok(releaseFirstCall, "the first handleMessages call should have started and be waiting");
  releaseFirstCall!();
  await firstUpdatePromise;

  // The queued second message must not be permanently stuck -- a third,
  // fresh message must still be processed normally afterward.
  await handleIncomingTelegramUpdate(textUpdate(3, 202, 777, "third, after recovery"), {
    debouncer,
    handleMessages,
    logger,
  });

  assert.ok(
    entries.some((e) => e.event === "conversation.unhandled_error"),
    "the failure must have been logged"
  );
  assert.ok(
    handledCalls.some((call) => call.includes("777:202")),
    "a fresh message after the failure must still reach handleMessages, proving the customer isn't permanently wedged"
  );
});
