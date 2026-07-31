/**
 * Just enough to greet a returning customer normally. Not a CRM: no order
 * history, no purchase data, no notes. Growing this needs a scoping
 * conversation first.
 */
export interface CustomerIdentity {
  /** Platform-qualified, e.g. "telegram:123456789". */
  customerId: string;
  preferredLanguage: string | null;
  /** Epoch ms. */
  firstSeen: number;
  /** Epoch ms. */
  lastSeen: number;
  /** False until the second time we hear from them. */
  isReturningCustomer: boolean;
  /** Set once B2B signals are confirmed (knowledge/b2b_signals.md). Never cleared. */
  isB2b: boolean;
  /** How the last conversation ended. A hint, not a transcript. */
  lastConversationSummary: string | null;
}

export const MAX_CONVERSATION_SUMMARY_LENGTH = 200;

export interface CustomerIdentityRepository {
  findById(customerId: string): Promise<CustomerIdentity | null>;

  /**
   * Creates the record on first contact, otherwise updates lastSeen and
   * flips isReturningCustomer. `now` is passed in rather than read from
   * the clock so this stays testable.
   */
  recordContact(
    customerId: string,
    now: number,
    preferredLanguage?: string | null
  ): Promise<CustomerIdentity>;

  /** One-way. Throws for an unknown customer -- that's a caller bug, not a reason to create one. */
  confirmB2b(customerId: string): Promise<void>;

  /** Truncates to MAX_CONVERSATION_SUMMARY_LENGTH. Throws for an unknown customer. */
  recordConversationSummary(customerId: string, summary: string): Promise<void>;
}
