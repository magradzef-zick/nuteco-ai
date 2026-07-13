import type {
  ConversationState,
  ConversationStateInput,
  ConversationStateRepository,
} from "../ConversationStateRepository";

/**
 * An in-memory implementation of ConversationStateRepository, satisfying
 * the same contract as SqliteConversationStateRepository -- see
 * InMemoryCustomerIdentityRepository for why this exists alongside the
 * SQLite one.
 */
export class InMemoryConversationStateRepository implements ConversationStateRepository {
  private readonly records = new Map<string, ConversationState>();

  async get(conversationId: string, now: number): Promise<ConversationState | null> {
    const state = this.records.get(conversationId);
    if (!state) return null;
    if (state.expiresAt <= now) return null;
    return state;
  }

  async save(state: ConversationStateInput, now: number, ttlMs: number): Promise<ConversationState> {
    const full: ConversationState = { ...state, updatedAt: now, expiresAt: now + ttlMs };
    this.records.set(state.conversationId, full);
    return full;
  }

  async clear(conversationId: string): Promise<void> {
    this.records.delete(conversationId);
  }

  async deleteExpired(now: number): Promise<number> {
    let count = 0;
    for (const [id, state] of this.records) {
      if (state.expiresAt <= now) {
        this.records.delete(id);
        count++;
      }
    }
    return count;
  }
}
