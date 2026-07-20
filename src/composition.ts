import type { Database } from "better-sqlite3";
import type { AppConfig } from "./config/config";
import { openDatabase } from "./storage/sqlite/connection";
import { SqliteCustomerIdentityRepository } from "./storage/sqlite/SqliteCustomerIdentityRepository";
import { SqliteConversationStateRepository } from "./storage/sqlite/SqliteConversationStateRepository";
import { SqliteProcessedMessageStore } from "./storage/sqlite/SqliteProcessedMessageStore";
import type { CustomerIdentityRepository } from "./storage/CustomerIdentityRepository";
import type { ConversationStateRepository } from "./storage/ConversationStateRepository";
import { HttpTelegramTransport } from "./adapters/telegram/HttpTelegramTransport";
import { TelegramMessageSender } from "./adapters/telegram/TelegramMessageSender";
import { parseUpdate } from "./adapters/telegram/parseUpdate";
import type { TelegramTransport } from "./adapters/telegram/TelegramTransport";
import { HttpInstagramTransport } from "./adapters/instagram/HttpInstagramTransport";
import { InstagramMessageSender } from "./adapters/instagram/InstagramMessageSender";
import { parseInstagramWebhookEvent } from "./adapters/instagram/parseWebhookEvent";
import type { InstagramTransport } from "./adapters/instagram/InstagramTransport";
import { PlatformRoutingMessageSender } from "./adapters/PlatformRoutingMessageSender";
import type { MessageSender } from "./adapters/MessageSender";
import type { ParsedUpdateResult } from "./adapters/ParsedUpdateResult";
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
  /** Present only when INSTAGRAM_* config is set -- see config.ts and src/index.ts. */
  instagramTransport: InstagramTransport | null;
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

  const sendersByPlatform: Record<string, MessageSender> = {
    telegram: new TelegramMessageSender({ transport }),
  };

  let instagramTransport: InstagramTransport | null = null;
  if (config.instagram) {
    instagramTransport = new HttpInstagramTransport({
      pageAccessToken: config.instagram.pageAccessToken,
      pageId: config.instagram.pageId,
      graphApiVersion: config.instagram.graphApiVersion,
      logger,
    });
    sendersByPlatform.instagram = new InstagramMessageSender({ transport: instagramTransport });
  }

  const messageSender = new PlatformRoutingMessageSender(sendersByPlatform);
  const identityRepository = new SqliteCustomerIdentityRepository(db);
  const conversationStateRepository = new SqliteConversationStateRepository(db);
  const debouncer = new MessageDebouncer({ persistedStore: new SqliteProcessedMessageStore(db) });
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
    // Manager notifications always go to Telegram regardless of which
    // platform a customer messaged in on -- there is only ever one
    // manager notification chat configured, and it's a Telegram chat ID.
    managerNotificationRecipientId: `telegram:${config.managerNotificationChatId}`,
  });

  return {
    config,
    transport,
    instagramTransport,
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
 * The platform-agnostic core shared by every adapter's webhook
 * entrypoint: runs one already-parsed update through the debouncer and
 * hands any ready batch to the message handler -- draining further
 * batches (per MessageDebouncer's protocol) until the customer is idle
 * again. handleIncomingTelegramUpdate and handleIncomingInstagramUpdate
 * below are thin, parser-specific wrappers around this -- the actual
 * debounce/dispatch/error-recovery logic exists exactly once, so adding a
 * platform never means duplicating it.
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
async function handleParsedUpdate(
  parsed: ParsedUpdateResult,
  deps: Pick<AppDependencies, "debouncer" | "handleMessages" | "logger">
): Promise<void> {
  if (parsed.kind === "unsupported") {
    deps.logger.info("webhook.update_unsupported", { updateType: parsed.updateType });
    return; // a real update/event shape this project doesn't act on yet -- not an error
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

/** Parses a raw Telegram update and runs it through the shared platform-agnostic core above. This is the function the Telegram webhook handler's `onUpdate` callback points at. */
export async function handleIncomingTelegramUpdate(
  rawUpdate: unknown,
  deps: Pick<AppDependencies, "debouncer" | "handleMessages" | "logger">
): Promise<void> {
  await handleParsedUpdate(parseUpdate(rawUpdate), deps);
}

/**
 * Parses a raw Instagram webhook POST body and runs each event it
 * contains through the shared platform-agnostic core above. This is the
 * function the Instagram webhook handler's `onEvent` callback points at.
 *
 * Unlike Telegram (exactly one update per webhook delivery), a single
 * Instagram webhook POST can batch multiple messaging events -- see
 * parseWebhookEvent.ts's doc comment. Each is processed sequentially, not
 * in parallel, so behavior stays as deterministic and easy to reason
 * about as the Telegram path.
 */
export async function handleIncomingInstagramUpdate(
  rawEvent: unknown,
  deps: Pick<AppDependencies, "debouncer" | "handleMessages" | "logger">
): Promise<void> {
  for (const parsed of parseInstagramWebhookEvent(rawEvent)) {
    await handleParsedUpdate(parsed, deps);
  }
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
