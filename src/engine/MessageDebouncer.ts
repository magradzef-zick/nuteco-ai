/**
 * Deterministically coalesces rapid-fire messages from the same customer
 * into a single processing batch, and makes duplicate/edited message
 * deliveries idempotent -- all without relying on wall-clock timing (a
 * fixed-time debounce window was rejected because correctness must never
 * depend on how many milliseconds apart two messages happen to arrive --
 * that would make behavior nondeterministic and hard to test reliably).
 *
 * The protocol:
 * 1. Every inbound message is passed to admit(). The caller acts on the
 *    result:
 *    - "duplicate": ignore it completely, nothing to do.
 *    - "queued": do nothing now -- this message will be included the next
 *      time a batch is handed back for this customer.
 *    - "process": a batch of messages (sorted into chronological order by
 *      `sequence`, not arrival order) is ready. Process it, then call
 *      complete().
 * 2. complete() marks the batch's messages as done and, if more messages
 *    queued up while it was working, immediately returns the next batch --
 *    the caller must process that one too, and call complete() again,
 *    until it returns null. This is what makes coalescing deterministic:
 *    the trigger for "there's more to do" is the previous batch finishing,
 *    an event, never a timer.
 *
 * Known, documented scope limit: once a message ID has been included in a
 * batch that is currently in flight or already completed, any further
 * delivery of that same ID (a duplicate webhook redelivery, or a customer
 * editing a message after we've already started or finished answering it)
 * is treated as a duplicate and ignored. Handling "the customer edited
 * their message after we replied" as a distinct, visible behavior is a
 * conversation-flow decision left to a higher layer -- this
 * infrastructure-level component intentionally does not decide that on
 * its own.
 */

export interface InboundMessage {
  /** Platform-qualified customer key, e.g. "telegram:123456789". */
  customerId: string;
  /** Platform-unique message identifier. */
  messageId: string;
  /** A monotonically-meaningful ordering hint (e.g. Telegram's message_id, or a timestamp). Used to sort a batch into chronological order regardless of arrival order. */
  sequence: number;
  /** The message content itself. Opaque to the debouncer. */
  payload: unknown;
}

export type AdmitResult =
  | { action: "duplicate" }
  | { action: "queued" }
  | { action: "process"; batch: InboundMessage[] };

/**
 * Durable "has this message ID already been fully processed" memory,
 * surviving process restarts -- unlike `recentlyProcessed` below, which is
 * deliberately in-memory-only for the fast, common case (coalescing
 * messages that arrive seconds apart within a single run). Optional: when
 * not provided, MessageDebouncer behaves exactly as it always has
 * (in-memory dedup only, reset on restart). See
 * SqliteProcessedMessageStore for the real implementation -- message IDs
 * from both platform adapters are already globally unique (they embed the
 * customer/chat ID), so a single unscoped table is safe.
 */
export interface ProcessedMessageStore {
  has(messageId: string): boolean;
  record(messageId: string): void;
}

interface CustomerQueue {
  inFlight: boolean;
  /** Message IDs in the batch currently handed to the caller, not yet complete()'d. */
  inFlightMessageIds: Set<string>;
  /** Messages waiting for the current in-flight batch to finish. */
  pending: Map<string, InboundMessage>;
  /** Bounded memory of recently-completed message IDs, oldest evicted first. Not persisted -- see class doc comment. */
  recentlyProcessed: string[];
}

const DEFAULT_MAX_RECENTLY_PROCESSED_PER_CUSTOMER = 200;

export class MessageDebouncer {
  private readonly maxRecentlyProcessed: number;
  private readonly persistedStore: ProcessedMessageStore | undefined;
  private readonly customers = new Map<string, CustomerQueue>();

  constructor(options?: {
    maxRecentlyProcessedPerCustomer?: number;
    persistedStore?: ProcessedMessageStore;
  }) {
    this.maxRecentlyProcessed =
      options?.maxRecentlyProcessedPerCustomer ?? DEFAULT_MAX_RECENTLY_PROCESSED_PER_CUSTOMER;
    this.persistedStore = options?.persistedStore;
  }

  admit(message: InboundMessage): AdmitResult {
    const queue = this.getOrCreateQueue(message.customerId);

    const isDuplicate =
      queue.recentlyProcessed.includes(message.messageId) ||
      queue.inFlightMessageIds.has(message.messageId) ||
      (this.persistedStore?.has(message.messageId) ?? false);

    if (isDuplicate) {
      return { action: "duplicate" };
    }

    // A brand-new message, or an edit/redelivery of one still only
    // waiting in the queue (not yet handed to the caller) -- either way,
    // this overwrites its own slot rather than creating a second one.
    queue.pending.set(message.messageId, message);

    if (queue.inFlight) {
      return { action: "queued" };
    }

    return { action: "process", batch: this.drain(queue) };
  }

  /**
   * The caller reports a batch as finished. If more messages queued up
   * while it was processing, the next batch is returned immediately (the
   * caller must process it and call complete() again); otherwise null,
   * meaning this customer is idle until their next message.
   */
  complete(customerId: string, processedMessageIds: string[]): InboundMessage[] | null {
    const queue = this.customers.get(customerId);
    if (!queue) {
      throw new Error(
        `complete() called for customer "${customerId}" with no active batch -- this indicates a caller bug (admit() must be called, and return "process", before complete()).`
      );
    }

    queue.recentlyProcessed.push(...processedMessageIds);
    if (queue.recentlyProcessed.length > this.maxRecentlyProcessed) {
      queue.recentlyProcessed.splice(0, queue.recentlyProcessed.length - this.maxRecentlyProcessed);
    }
    for (const messageId of processedMessageIds) {
      this.persistedStore?.record(messageId);
    }
    queue.inFlightMessageIds.clear();

    if (queue.pending.size === 0) {
      queue.inFlight = false;
      return null;
    }

    return this.drain(queue);
  }

  private getOrCreateQueue(customerId: string): CustomerQueue {
    let queue = this.customers.get(customerId);
    if (!queue) {
      queue = {
        inFlight: false,
        inFlightMessageIds: new Set(),
        pending: new Map(),
        recentlyProcessed: [],
      };
      this.customers.set(customerId, queue);
    }
    return queue;
  }

  private drain(queue: CustomerQueue): InboundMessage[] {
    const batch = [...queue.pending.values()].sort((a, b) => a.sequence - b.sequence);
    queue.pending.clear();
    queue.inFlight = true;
    queue.inFlightMessageIds = new Set(batch.map((m) => m.messageId));
    return batch;
  }
}
