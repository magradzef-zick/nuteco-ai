/**
 * The persistent identity record -- and ONLY this. It exists solely so
 * the assistant can greet a returning customer normally instead of
 * treating every message as a stranger. It is deliberately NOT a CRM: no
 * order history, no purchase data, no free-form notes. If a future
 * requirement needs more than this, that's a scoping conversation, not a
 * reason to quietly grow this type.
 */
export interface CustomerIdentity {
  /** Platform-qualified key, e.g. "telegram:123456789". Constructed by the messaging adapter layer. */
  customerId: string;
  /** The language of the customer's most recent message, if known. */
  preferredLanguage: string | null;
  /** Epoch milliseconds of the first message we ever received from this customer. */
  firstSeen: number;
  /** Epoch milliseconds of the most recent message. */
  lastSeen: number;
  /** False until the second time we ever hear from this customer. */
  isReturningCustomer: boolean;
  /** Set once B2B signals are confirmed (see knowledge/b2b_signals.md). Never silently cleared. */
  isB2b: boolean;
  /** A short note on how the last conversation ended, or null. Not a transcript -- see MAX_CONVERSATION_SUMMARY_LENGTH. */
  lastConversationSummary: string | null;
}

/** Enforced by every implementation: this is a hint for a greeting, not an archive. */
export const MAX_CONVERSATION_SUMMARY_LENGTH = 200;

export interface CustomerIdentityRepository {
  /** Returns the identity record for this customer, or null if we've never heard from them. */
  findById(customerId: string): Promise<CustomerIdentity | null>;

  /**
   * Records contact with this customer at time `now`. Creates a new record
   * on first contact (isReturningCustomer = false); on every later call,
   * updates lastSeen and sets isReturningCustomer to true. `now` is always
   * passed explicitly by the caller rather than read from the system clock
   * in here, so this stays deterministic and trivially testable.
   */
  recordContact(
    customerId: string,
    now: number,
    preferredLanguage?: string | null
  ): Promise<CustomerIdentity>;

  /**
   * Marks this customer as a confirmed B2B account. There is deliberately
   * no method to un-set this -- once confirmed, it is never silently
   * cleared. Calling this for a customer we've never recorded contact
   * with is a caller bug and must throw, not silently create one.
   */
  confirmB2b(customerId: string): Promise<void>;

  /**
   * Overwrites the short last-conversation summary. Longer summaries are
   * truncated to MAX_CONVERSATION_SUMMARY_LENGTH. Calling this for an
   * unknown customer is a caller bug and must throw.
   */
  recordConversationSummary(customerId: string, summary: string): Promise<void>;
}
