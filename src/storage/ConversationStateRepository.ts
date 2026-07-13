/**
 * Short-lived, per-conversation working state. Unlike CustomerIdentity,
 * this is expected to disappear once a conversation goes cold. Nothing
 * here is meant to survive beyond the conversation it belongs to.
 */
export interface ConversationState {
  conversationId: string;
  currentIntent: string | null;
  orderDraft: Record<string, unknown>;
  currentStep: string | null;
  pendingClarification: string | null;
  escalationFlag: boolean;
  variables: Record<string, unknown>;
  /** Epoch ms this state was last written. */
  updatedAt: number;
  /** Epoch ms after which this state is considered gone, even if the row still physically exists. */
  expiresAt: number;
}

/** What a caller provides when saving; timestamps are computed by the repository, not the caller. */
export type ConversationStateInput = Omit<ConversationState, "updatedAt" | "expiresAt">;

export interface ConversationStateRepository {
  /**
   * Returns the state, or null if none exists OR it has expired. Expiry is
   * checked here on every read (lazy expiry) so correctness never depends
   * on a cleanup job having run -- deleteExpired() is a housekeeping
   * optimization, not a correctness requirement.
   */
  get(conversationId: string, now: number): Promise<ConversationState | null>;

  /**
   * Creates or replaces the state for a conversation, setting expiresAt to
   * `now + ttlMs`. Every save extends the conversation's life -- this is
   * how an active back-and-forth stays alive while a truly abandoned one
   * expires on its own.
   */
  save(state: ConversationStateInput, now: number, ttlMs: number): Promise<ConversationState>;

  /** Deletes the state for a conversation outright (e.g. handed off to a manager, or explicitly closed). */
  clear(conversationId: string): Promise<void>;

  /** Physically deletes all rows expired as of `now`. Returns how many were removed. Safe to call on a schedule, or never. */
  deleteExpired(now: number): Promise<number>;
}

/** 30 minutes: long enough to outlast the 15-minute reminder rule, short enough that this never becomes long-term memory. */
export const DEFAULT_CONVERSATION_STATE_TTL_MS = 30 * 60 * 1000;
