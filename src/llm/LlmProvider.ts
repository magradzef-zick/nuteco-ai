/**
 * The port (interface) for generating a reply from a language model.
 * Deliberately provider-agnostic -- nothing in this file mentions any
 * specific vendor. The Conversation Engine depends only on this
 * interface, never on a concrete provider, so swapping models later (or
 * running a different provider for a different client) means writing one
 * new class here and changing one line in the composition root -- the
 * same dependency-inversion pattern already used for storage
 * (src/storage/) and messaging (src/adapters/MessageSender.ts).
 */

export interface LlmConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * A file sent alongside the customer's message -- a voice message, a
 * photo of a product, a screenshot, a PDF -- for a model that can read it
 * directly. Deliberately just bytes plus a MIME type: no Telegram
 * `file_id`, no URL, nothing tying this port to how the file was obtained
 * or which platform it came from.
 */
export interface LlmAttachment {
  /** e.g. "audio/ogg", "image/jpeg", "application/pdf". What the model uses to decide how to decode `dataBase64`. */
  mimeType: string;
  dataBase64: string;
}

export interface LlmReplyRequest {
  /** The full system prompt for this turn, including the injected knowledge base -- see src/prompts/loader.ts. */
  systemPrompt: string;
  /** Prior turns in this conversation, oldest first. Bounded by the caller (see ConversationEngine's MAX_HISTORY_TURNS). */
  historyTurns: LlmConversationTurn[];
  /** The customer's new message for this turn. */
  newUserMessage: string;
  /**
   * Files attached to this turn, if any. Sent only with the new message,
   * never replayed as part of `historyTurns` -- re-uploading every photo
   * and voice message a conversation ever contained on every subsequent
   * turn would grow the request without bound. The model's own reply
   * carries what mattered forward instead.
   */
  attachments?: LlmAttachment[];
}

export interface LlmReplyResult {
  text: string;
  /**
   * True when the model stopped because it hit its output token limit
   * mid-reply (Gemini's `finishReason: "MAX_TOKENS"`), not because it
   * finished naturally. `text` still holds whatever partial text the model
   * produced -- the caller decides whether a partial reply is acceptable
   * to send. It never is, in practice: a reply cut off mid-sentence with
   * no continuation is worse than an honest "let me connect you with our
   * team." See ConversationEngine's escalation handling.
   */
  truncated: boolean;
}

export interface LlmProvider {
  generateReply(request: LlmReplyRequest): Promise<LlmReplyResult>;

  /**
   * A cheap, no-token-cost call that confirms the provider is reachable
   * and the API key is valid. Used only for startup validation (mirrors
   * TelegramTransport.getMe's role) -- never called on the hot path.
   */
  checkHealth(): Promise<void>;
}
