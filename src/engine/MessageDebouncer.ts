/**
 * Coalesces rapid-fire messages from one customer into a single batch and
 * makes redelivery idempotent, without a timer: a fixed debounce window
 * would make correctness depend on arrival milliseconds.
 *
 * Protocol:
 * 1. Pass every message to admit(), then act on the result:
 *    - "duplicate": ignore.
 *    - "queued": nothing to do; it joins the next batch.
 *    - "process": a batch (ordered by `sequence`, not arrival) is ready --
 *      handle it, then call complete().
 * 2. complete() marks the batch done and returns the next one if messages
 *    queued meanwhile. Keep going until it returns null. The trigger is
 *    the previous batch finishing, never a timer -- that's what makes it
 *    deterministic.
 *
 * Scope limit: once an ID is in a batch that is in flight or done, any
 * further delivery of it is a duplicate. Treating "customer edited after
 * we replied" as its own behavior is a conversation-flow decision for a
 * higher layer.
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
