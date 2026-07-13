import type { Database } from "better-sqlite3";
import type {
  ConversationState,
  ConversationStateInput,
  ConversationStateRepository,
} from "../ConversationStateRepository";

interface Row {
  conversation_id: string;
  current_intent: string | null;
  order_draft: string;
  current_step: string | null;
  pending_clarification: string | null;
  escalation_flag: number;
  variables: string;
  updated_at: number;
  expires_at: number;
}

function rowToState(row: Row): ConversationState {
  return {
    conversationId: row.conversation_id,
    currentIntent: row.current_intent,
    orderDraft: JSON.parse(row.order_draft),
    currentStep: row.current_step,
    pendingClarification: row.pending_clarification,
    escalationFlag: row.escalation_flag === 1,
    variables: JSON.parse(row.variables),
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export class SqliteConversationStateRepository implements ConversationStateRepository {
  constructor(private readonly db: Database) {}

  async get(conversationId: string, now: number): Promise<ConversationState | null> {
    const row = this.db
      .prepare("SELECT * FROM conversation_state WHERE conversation_id = ?")
      .get(conversationId) as Row | undefined;

    if (!row) return null;
    if (row.expires_at <= now) return null; // lazily expired -- treated as gone even if still physically present

    return rowToState(row);
  }

  async save(state: ConversationStateInput, now: number, ttlMs: number): Promise<ConversationState> {
    const expiresAt = now + ttlMs;

    this.db
      .prepare(
        `INSERT INTO conversation_state
           (conversation_id, current_intent, order_draft, current_step, pending_clarification, escalation_flag, variables, updated_at, expires_at)
         VALUES (@conversationId, @currentIntent, @orderDraft, @currentStep, @pendingClarification, @escalationFlag, @variables, @updatedAt, @expiresAt)
         ON CONFLICT(conversation_id) DO UPDATE SET
           current_intent = excluded.current_intent,
           order_draft = excluded.order_draft,
           current_step = excluded.current_step,
           pending_clarification = excluded.pending_clarification,
           escalation_flag = excluded.escalation_flag,
           variables = excluded.variables,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`
      )
      .run({
        conversationId: state.conversationId,
        currentIntent: state.currentIntent,
        orderDraft: JSON.stringify(state.orderDraft),
        currentStep: state.currentStep,
        pendingClarification: state.pendingClarification,
        escalationFlag: state.escalationFlag ? 1 : 0,
        variables: JSON.stringify(state.variables),
        updatedAt: now,
        expiresAt,
      });

    return { ...state, updatedAt: now, expiresAt };
  }

  async clear(conversationId: string): Promise<void> {
    this.db.prepare("DELETE FROM conversation_state WHERE conversation_id = ?").run(conversationId);
  }

  async deleteExpired(now: number): Promise<number> {
    const result = this.db.prepare("DELETE FROM conversation_state WHERE expires_at <= ?").run(now);
    return result.changes;
  }
}
