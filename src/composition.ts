import type { Database } from "better-sqlite3";
import type { AppConfig } from "./config/config";
import { openDatabase } from "./storage/sqlite/connection";
import { SqliteCustomerIdentityRepository } from "./storage/sqlite/SqliteCustomerIdentityRepository";
import { SqliteConversationStateRepository } from "./storage/sqlite/SqliteConversationStateRepository";
import type { CustomerIdentityRepository } from "./storage/CustomerIdentityRepository";
import type { ConversationStateRepository } from "./storage/ConversationStateRepository";
import { HttpTelegramTransport } from "./adapters/telegram/HttpTelegramTransport";
import { TelegramMessageSender } from "./adapters/telegram/TelegramMessageSender";
import { parseUpdate } from "./adapters/telegram/parseUpdate";
import type { TelegramTransport } from "./adapters/telegram/TelegramTransport";
import type { MessageSender } from "./adapters/MessageSender";
import { MessageDebouncer, type InboundMessage } from "./engine/MessageDebouncer";
import { createConversationEngine } from "./engine/ConversationEngine";
import { GeminiProvider } from "./llm/gemini/GeminiProvider";
import type { LlmProvider } from "./llm/LlmProvider";
import { loadKnowledgeBase } from "./knowledge/loader";
import { loadSystemPrompt } from "./prompts/loader";
import { createLogger, type Logger } from "./observability/logger";

/**
 * The composition root: the one place concrete implementations are chosen
 * and wired together. Everything else in the codebase depends on
 * interfaces (TelegramTransport, MessageSender, CustomerIdentityRepository,
 * ...), never on this file -- this is deliberate, explicit dependency
 * injection (plain constructor calls, no DI container/framework), matching
 * the same pattern used for storage in src/storage/.
 */
export interface AppDependencies {
  config: AppConfig;
  transport: TelegramTransport;
  messageSender: MessageSender;
  identityRepository: CustomerIdentityRepository;
  conversationStateRepository: ConversationStateRepository;
  debouncer: MessageDebouncer;
  /** Currently GeminiProvider -- everything upstream of this depends only on LlmProvider, so swapping models means changing this one field's construction below, not anything else in the file. */
  llmProvider: LlmProvider;
  handleMessages: (customerId: string, messages: InboundMessage[]) => Promise<void>;
  logger: Logger;
  /** Exposed only for the startup database-connectivity check (src/startup/validateStartup.ts's databaseCheck) -- business logic should go through identityRepository/conversationStateRepository instead. */
  db: Database;
  /** Releases held resources (currently: the database connection). Called during graceful shutdown -- see src/lifecycle/shutdown.ts. */
  close: () => void;
}

export function buildDependencies(config: AppConfig, logger: Logger = createLogger()): AppDependencies {
  const db = openDatabase(config.databasePath);
  const transport = new HttpTelegramTransport({ botToken: config.telegramBotToken, logger });
  const messageSender = new TelegramMessageSender({ transport });
  const identityRepository = new SqliteCustomerIdentityRepository(db);
  const conversationStateRepository = new SqliteConversationStateRepository(db);
  const debouncer = new MessageDebouncer();
  const llmProvider = new GeminiProvider({ apiKey: config.geminiApiKey, model: config.geminiModel, logger });

  const handleMessages = createConversationEngine({
    llmProvider,
    messageSender,
    identityRepository,
    conversationStateRepository,
    getSystemPromptText: () => loadSystemPrompt(config.promptsDir),
    getKnowledgeBaseText: () => loadKnowledgeBase({ knowledgeDir: config.knowledgeBaseDir }),
    now: () => Date.now(),
    logger,
    // Telegram-specific formatting decision (the "telegram:" prefix) made
    // here, the one place this project's concrete platform choices are
    // made -- ConversationEngine itself treats this the same opaque way
    // it treats every customerId, never assuming or inspecting the format.
    managerNotificationRecipientId: `telegram:${config.managerNotificationChatId}`,
  });

  return {
    config,
    transport,
    messageSender,
    identityRepository,
    conversationStateRepository,
    debouncer,
    llmProvider,
    handleMessages,
    logger,
    db,
    close: () => db.close(),
  };
}

/**
 * Parses a raw Telegram update, runs it through the debouncer, and hands
 * any ready batch to the message handler -- draining further batches (per
 * MessageDebouncer's protocol) until the customer is idle again. This is
 * the function the webhook handler's `onUpdate` callback points at.
 *
 * Logging note: `conversation.started` / `conversation.ended` map onto the
 * real signals available today -- "a batch of messages is about to be
 * handled" and "this customer has no more messages queued, at least for
 * now" -- not a full session-lifecycle model (there is no
 * escalation/hand-off/TTL-expiry concept driving these yet). The event
 * names are the ones expected for production observability; the trigger
 * they map to is documented here so nobody mistakes this for more than
 * it is.
 */
export async function handleIncomingTelegramUpdate(
  rawUpdate: unknown,
  deps: Pick<AppDependencies, "debouncer" | "handleMessages" | "logger">
): Promise<void> {
  const parsed = parseUpdate(rawUpdate);

  if (parsed.kind === "unsupported") {
    deps.logger.info("webhook.update_unsupported", { updateType: parsed.updateType });
    return; // a real Telegram update type this project doesn't act on yet -- not an error
  }

  const admitResult = deps.debouncer.admit(parsed.message);

  if (admitResult.action === "duplicate") {
    deps.logger.info("message.duplicate_ignored", {
      customerId: parsed.message.customerId,
      messageId: parsed.message.messageId,
    });
    return;
  }

  if (admitResult.action === "queued") {
    deps.logger.debug("message.queued", {
      customerId: parsed.message.customerId,
      messageId: parsed.message.messageId,
    });
    return;
  }

  await drainBatches(parsed.message.customerId, admitResult.batch, deps);
}

/**
 * `handleMessages` handles its own recoverable failures internally (an
 * unreachable LLM, a blocked reply) and never throws. Reaching the
 * `catch` below therefore means a genuinely unexpected failure (a bug,
 * not a known/handled condition). Per MessageDebouncer's own protocol,
 * only `complete()` clears a customer's "in flight" flag -- if an
 * exception here aborted this function without ever calling
 * `deps.debouncer.complete(...)` for the in-flight batch, the result
 * would be a silent, permanent deadlock: every future message from that
 * customer queued forever and never processed again. `drainStuck` below
 * guarantees this customer's queue always returns to a clean, idle state
 * no matter what happens above -- a last-resort backstop, not the primary
 * defense (the primary defense is ConversationEngine not throwing for
 * expected failure modes in the first place).
 */
async function drainBatches(
  customerId: string,
  firstBatch: InboundMessage[],
  deps: Pick<AppDependencies, "debouncer" | "handleMessages" | "logger">
): Promise<void> {
  let batch: InboundMessage[] | null = firstBatch;
  let isFirstBatch = true;

  while (batch !== null) {
    if (isFirstBatch) {
      deps.logger.info("conversation.started", { customerId, messageCount: batch.length });
      isFirstBatch = false;
    }

    const currentBatch = batch;
    try {
      await deps.handleMessages(customerId, currentBatch);
      batch = deps.debouncer.complete(
        customerId,
        currentBatch.map((message) => message.messageId)
      );
    } catch (error) {
      deps.logger.error("conversation.unhandled_error", { customerId, error: (error as Error).message });
      drainStuck(customerId, currentBatch, deps.debouncer);
      batch = null;
    }
  }

  deps.logger.info("conversation.ended", { customerId });
}

/**
 * Flushes every batch still queued for `customerId` -- including the one
 * that was in flight when an unexpected error occurred -- back to an idle
 * state, without attempting to process any of them further. Those specific
 * messages will not get a reply, which is an accepted, honest tradeoff for
 * a rare, genuinely-unexpected failure: it is still strictly better than
 * the alternative (this customer's every future message silently queued
 * and never answered again).
 */
function drainStuck(customerId: string, currentBatch: InboundMessage[], debouncer: MessageDebouncer): void {
  let next: InboundMessage[] | null = debouncer.complete(
    customerId,
    currentBatch.map((message) => message.messageId)
  );
  while (next !== null) {
    const batch = next;
    next = debouncer.complete(
      customerId,
      batch.map((message) => message.messageId)
    );
  }
}
