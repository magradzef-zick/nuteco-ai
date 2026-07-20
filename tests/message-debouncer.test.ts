import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageDebouncer } from "../src/engine/MessageDebouncer";

test("the first message for a customer is processed immediately", () => {
  const debouncer = new MessageDebouncer();
  const result = debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "hi" });

  assert.equal(result.action, "process");
  if (result.action === "process") {
    assert.equal(result.batch.length, 1);
    assert.equal(result.batch[0].messageId, "m1");
  }
});

test("a second message arriving while the first is still being processed is coalesced into the next batch", () => {
  const debouncer = new MessageDebouncer();
  const first = debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  assert.equal(first.action, "process");

  const second = debouncer.admit({ customerId: "c1", messageId: "m2", sequence: 2, payload: "b" });
  assert.equal(second.action, "queued");

  const next = debouncer.complete("c1", ["m1"]);
  assert.notEqual(next, null);
  assert.equal(next?.length, 1);
  assert.equal(next?.[0].messageId, "m2");
});

test("complete() returns null when nothing else is queued", () => {
  const debouncer = new MessageDebouncer();
  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  const next = debouncer.complete("c1", ["m1"]);
  assert.equal(next, null);
});

test("a duplicate delivery of a message currently in flight is ignored, not double-processed", () => {
  const debouncer = new MessageDebouncer();
  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });

  const duplicate = debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  assert.equal(duplicate.action, "duplicate");

  const next = debouncer.complete("c1", ["m1"]);
  assert.equal(next, null, "the duplicate must not cause a second batch");
});

test("a duplicate delivery of an already-completed message is ignored", () => {
  const debouncer = new MessageDebouncer();
  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  debouncer.complete("c1", ["m1"]);

  const redelivered = debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  assert.equal(redelivered.action, "duplicate");
});

test("an edited message still waiting in the queue overwrites its own slot instead of duplicating", () => {
  const debouncer = new MessageDebouncer();
  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "first message" });
  debouncer.admit({ customerId: "c1", messageId: "m2", sequence: 2, payload: "edit me" });
  debouncer.admit({ customerId: "c1", messageId: "m2", sequence: 2, payload: "edited content" });

  const next = debouncer.complete("c1", ["m1"]);
  assert.equal(next?.length, 1, "the edited message should occupy one slot, not two");
  assert.equal(next?.[0].payload, "edited content", "the latest edit should win");
});

test("a batch is sorted into sequence order even if messages were admitted out of order", () => {
  const debouncer = new MessageDebouncer();
  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "first" });
  debouncer.admit({ customerId: "c1", messageId: "m3", sequence: 3, payload: "third" });
  debouncer.admit({ customerId: "c1", messageId: "m2", sequence: 2, payload: "second" });

  const next = debouncer.complete("c1", ["m1"]);
  assert.deepEqual(
    next?.map((m) => m.sequence),
    [2, 3],
    "queued messages should be handed back in sequence order, not admission order"
  );
});

test("different customers are debounced independently", () => {
  const debouncer = new MessageDebouncer();
  const a = debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  const b = debouncer.admit({ customerId: "c2", messageId: "m1", sequence: 1, payload: "b" });

  assert.equal(a.action, "process");
  assert.equal(b.action, "process", "a different customer must not be blocked by c1 being in flight");
});

test("the recently-processed memory is bounded and evicts the oldest entries first", () => {
  const debouncer = new MessageDebouncer({ maxRecentlyProcessedPerCustomer: 2 });

  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  debouncer.complete("c1", ["m1"]);
  debouncer.admit({ customerId: "c1", messageId: "m2", sequence: 2, payload: "b" });
  debouncer.complete("c1", ["m2"]);
  debouncer.admit({ customerId: "c1", messageId: "m3", sequence: 3, payload: "c" });
  debouncer.complete("c1", ["m3"]);

  // m1 has fallen out of the bounded memory (limit = 2), so re-admitting it
  // is treated as a brand-new message rather than a duplicate. This is a
  // documented, deliberate bound, not a correctness requirement -- see the
  // module's doc comment.
  const result = debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 4, payload: "a-again" });
  assert.equal(result.action, "process");
});

test("complete() throws if called for a customer with no active batch (a caller bug guard)", () => {
  const debouncer = new MessageDebouncer();
  assert.throws(() => debouncer.complete("never-admitted", ["m1"]));
});

test("a message recorded in the persisted store is treated as a duplicate, even by a fresh debouncer instance", () => {
  const recorded = new Set<string>();
  const persistedStore = {
    has: (messageId: string) => recorded.has(messageId),
    record: (messageId: string) => {
      recorded.add(messageId);
    },
  };

  const debouncer = new MessageDebouncer({ persistedStore });
  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  debouncer.complete("c1", ["m1"]);

  // Simulates a process restart: a brand-new MessageDebouncer, with no
  // in-memory history of its own, backed by the same underlying store.
  const afterRestart = new MessageDebouncer({ persistedStore });
  const result = afterRestart.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  assert.equal(result.action, "duplicate");
});

test("without a persisted store, a fresh debouncer instance has no memory of prior messages", () => {
  const debouncer = new MessageDebouncer();
  debouncer.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  debouncer.complete("c1", ["m1"]);

  const afterRestart = new MessageDebouncer();
  const result = afterRestart.admit({ customerId: "c1", messageId: "m1", sequence: 1, payload: "a" });
  assert.equal(result.action, "process", "sanity check -- this is the pre-existing, unpersisted behavior");
});
