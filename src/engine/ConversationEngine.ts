import type { InboundMessage } from "./MessageDebouncer";
import type { NormalizedMessage } from "../adapters/NormalizedMessage";
import type { MessageSender } from "../adapters/MessageSender";
import type { CustomerIdentityRepository } from "../storage/CustomerIdentityRepository";
import {
  DEFAULT_CONVERSATION_STATE_TTL_MS,
  type ConversationStateRepository,
} from "../storage/ConversationStateRepository";
import type { LlmProvider, LlmConversationTurn, LlmReplyResult } from "../llm/LlmProvider";
import { checkForUnverifiedNumbers } from "./hallucinationGuardrail";
import { detectStrongB2bSignal } from "./b2bDetector";
import { detectLanguage } from "./languageDetector";
import { fallbackMessage } from "./fallbackMessages";
import type { Logger } from "../observability/logger";

/**
 * The Conversation Engine. Platform-agnostic on purpose -- nothing here
 * imports anything from src/adapters/telegram/. It depends only on
 * MessageSender (interface), the storage repositories (interfaces), and
 * LlmProvider (interface), the same dependency-inversion pattern used
 * everywhere else in this project.
 *
 * Any failure along the way -- the LLM unreachable, the store unreachable,
 * a truncated reply, a failed hallucination check -- is treated as an
 * escalation: the customer always gets a reply, never silence, and
 * `handleMessages` always resolves normally. B2B/wholesale detection has
 * a deterministic backstop (`detectStrongB2bSignal`, see b2bDetector.ts)
 * checked before the LLM is even called, so a strong signal escalates
 * immediately regardless of what the LLM would have judged.
 *
 * Every fallback/escalation path here bypasses the LLM entirely, so the
 * system prompt's "reply in the customer's language" instruction -- which
 * only governs text the LLM itself generates -- has no authority over
 * these messages. They go through `languageDetector.ts` (a deterministic
 * classifier that works even when the LLM is unreachable) and
 * `fallbackMessages.ts` (a trilingual, reason-specific message set) instead,
 * so a customer is told *why* the assistant stopped, not just that it did.
 *
 * `escalated` can be set by four mechanical, code-level triggers (a B2B
 * keyword match, an LLM/store failure, a truncated reply, a guardrail
 * block), or by the LLM's own conversational judgment (a complaint, a
 * discount request, a medical question) -- signaled by a small, fixed
 * marker (`ESCALATION_MARKER`) it appends to its own reply per the
 * Escalation Rules in `prompts/system_prompt.md`. The marker is stripped
 * before the customer ever sees it and used only as a deterministic
 * signal to notify a manager via `MessageSender`, addressed the same
 * opaque way as any customer (`managerNotificationRecipientId`).
 */

/** Bounded so conversation history contributes a roughly stable, small amount to every prompt -- not unlimited memory. */
const MAX_HISTORY_TURNS = 20;

/**
 * A literal, fixed marker the model appends to its own reply when its own
 * judgment (per the Escalation Rules in the system prompt) is that this
 * turn needs a human -- e.g. a complaint, a discount request, a medical
 * question, a softer wholesale signal the deterministic pre-filter
 * doesn't catch. Stripped before the customer ever sees it; its only
 * purpose is giving this code a deterministic signal for escalations that
 * are the model's own conversational judgment call, not one of the
 * mechanical, code-level triggers that already set `escalated` some
 * other way.
 */
const ESCALATION_MARKER = "[ESCALATE]";

/**
 * Strips `ESCALATION_MARKER` from the end of `text`, if present, and
 * reports whether it was there. Only recognizes it as the very last thing
 * in the (trimmed) reply -- deliberately not a blanket find-and-remove
 * anywhere in the text, so an incidental or quoted occurrence elsewhere
 * can't be misread as the model's actual signal.
 */
function extractEscalationSignal(text: string): { text: string; modelSignaledEscalation: boolean } {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(ESCALATION_MARKER)) {
    return {
      text: trimmed.slice(0, trimmed.length - ESCALATION_MARKER.length).trimEnd(),
      modelSignaledEscalation: true,
    };
  }
  return { text, modelSignaledEscalation: false };
}

export interface ConversationEngineDependencies {
  llmProvider: LlmProvider;
  messageSender: MessageSender;
  identityRepository: CustomerIdentityRepository;
  conversationStateRepository: ConversationStateRepository;
  /** The static system prompt text (from prompts/system_prompt.md), without the knowledge base appended -- this function appends it per turn so an edited knowledge base takes effect without a restart. */
  getSystemPromptText: () => string;
  getKnowledgeBaseText: () => string;
  now: () => number;
  logger: Logger;
  /**
   * Pre-formatted recipient identifier for manager escalation
   * notifications, in the same opaque form as any customer id (e.g.
   * "telegram:5820636046") -- constructed by composition.ts, the one
   * place platform-specific formatting is decided. ConversationEngine
   * never inspects or assumes this format, matching how it already treats
   * every customerId as opaque.
   */
  managerNotificationRecipientId: string;
}

interface StoredHistory {
  history: LlmConversationTurn[];
}

/**
 * Best-effort: notifies the manager chat with the escalation reason and
 * the customer's message this turn. Never allowed to affect the
 * customer's own reply -- a failure here is logged
 * (`manager_notification.failed`) and swallowed, not thrown, since the
 * customer already has their reply by the time this runs. Always
 * written in Russian (the internal working language),
 * regardless of the customer's own language -- this goes to Nuteco
 * staff, not the customer, so the language-matching guarantee that
 * governs every customer-facing message does not apply here.
 */
async function notifyManager(
  deps: Pick<ConversationEngineDependencies, "messageSender" | "managerNotificationRecipientId" | "logger">,
  context: { customerId: string; reason: string; customerMessage: string }
): Promise<void> {
  const notificationText = [
    `Эскалация (${context.reason})`,
    `Клиент: ${context.customerId}`,
    `Сообщение: ${context.customerMessage}`,
  ].join("\n");

  try {
    await deps.messageSender.sendReply(deps.managerNotificationRecipientId, [notificationText]);
    deps.logger.info("manager_notification.sent", { customerId: context.customerId, reason: context.reason });
  } catch (error) {
    deps.logger.error("manager_notification.failed", {
      customerId: context.customerId,
      reason: context.reason,
      error: (error as Error).message,
    });
  }
}

export function createConversationEngine(deps: ConversationEngineDependencies) {
  return async function handleMessages(customerId: string, messages: InboundMessage[]): Promise<void> {
    const now = deps.now();
    const conversationId = customerId; // one conversation per customer, for now

    // Detected once, up front, from the raw incoming text -- before any
    // I/O that could fail, and before we even know whether this batch has
    // usable text at all. Every fallback path below needs a language to
    // reply in, including ones that fire before combinedUserMessage would
    // normally be computed (e.g. an identity-store failure on the very
    // first line of this function) -- computing it here once, synchronously,
    // means every one of those paths can use it without depending on
    // Gemini (which is exactly unavailable in the llm_unavailable case) or
    // on a repository read (which is exactly unavailable in the
    // state_store_unavailable case) having succeeded.
    const rawPayloads = messages.map((message) => message.payload as NormalizedMessage);
    const rawText = rawPayloads
      .map((payload) => payload.text)
      .filter((text): text is string => text !== null && text.trim().length > 0)
      .join("\n");
    const language = detectLanguage(rawText);

    // Fail closed, not open: if the persistent store can't be reached, the
    // right behavior is an honest escalation, never silence and never a
    // stateless fallback reply (which would silently reproduce "forgets
    // what was just said" -- the exact failure mode that sank the earlier
    // bot prototype). Previously, a store failure here propagated
    // uncaught and left the customer with no reply at all.
    try {
      await deps.identityRepository.recordContact(customerId, now);
    } catch (error) {
      deps.logger.error("escalation.triggered", {
        customerId,
        reason: "state_store_unavailable",
        error: (error as Error).message,
      });
      await deps.messageSender.sendReply(customerId, [fallbackMessage("technicalHiccup", language)]);
      await notifyManager(deps, { customerId, reason: "state_store_unavailable", customerMessage: rawText });
      return;
    }

    const textMessages = rawPayloads.filter((payload) => payload.text !== null && payload.text.trim().length > 0);

    if (textMessages.length === 0) {
      // Every message in this batch was voice/photo/video/sticker-only --
      // a deterministic, correct answer already exists for this, so
      // there's no need to spend an LLM call on it.
      deps.logger.info("conversation.media_fallback", { customerId, mediaTypes: rawPayloads.map((p) => p.mediaType) });
      await deps.messageSender.sendReply(customerId, [fallbackMessage("mediaFallback", language)]);
      return;
    }

    const combinedUserMessage = rawText;

    let state: Awaited<ReturnType<ConversationStateRepository["get"]>>;
    try {
      state = await deps.conversationStateRepository.get(conversationId, now);
    } catch (error) {
      deps.logger.error("escalation.triggered", {
        customerId,
        reason: "state_store_unavailable",
        error: (error as Error).message,
      });
      await deps.messageSender.sendReply(customerId, [fallbackMessage("technicalHiccup", language)]);
      await notifyManager(deps, { customerId, reason: "state_store_unavailable", customerMessage: combinedUserMessage });
      return;
    }
    const history = extractHistory(state?.variables);

    let finalReplyText: string;
    let escalated: boolean;
    let escalationReason: string | null;

    if (detectStrongB2bSignal(combinedUserMessage)) {
      // Deterministic backstop -- never calls the LLM for this turn. A
      // strong signal is unambiguous enough that there's nothing to gain
      // from a model call, only cost and a chance the model's own
      // judgment misses it on this particular turn. Does not (yet)
      // suppress future turns in this conversation -- that requires
      // tracking whether a human has since taken over, which nothing in
      // this codebase does today.
      deps.logger.error("escalation.triggered", { customerId, reason: "b2b_signal_detected" });
      finalReplyText = fallbackMessage("b2bEscalation", language);
      escalated = true;
      escalationReason = "b2b_signal_detected";
    } else {
      await deps.messageSender.sendTyping(customerId);

      const knowledgeBaseText = deps.getKnowledgeBaseText();
      const systemPrompt = `${deps.getSystemPromptText()}\n\n${knowledgeBaseText}`;

      let reply: LlmReplyResult | null = null;
      try {
        reply = await deps.llmProvider.generateReply({
          systemPrompt,
          historyTurns: history,
          newUserMessage: combinedUserMessage,
        });
      } catch (error) {
        // The LLM being unreachable (network failure, rate limit
        // exhausted, an API outage) is an expected, recoverable failure
        // mode, not a bug -- the customer must still get a reply, never
        // silence. `reply` staying null below is what routes to the
        // fallback message.
        deps.logger.error("escalation.triggered", {
          customerId,
          reason: "llm_unavailable",
          error: (error as Error).message,
        });
      }

      if (reply === null) {
        finalReplyText = fallbackMessage("technicalHiccup", language);
        escalated = true;
        escalationReason = "llm_unavailable";
      } else if (reply.truncated) {
        // A reply cut off mid-sentence (Gemini hit its output token limit)
        // is never safe to send as-is -- there is no continuation coming,
        // so the customer would just receive a broken fragment. Checked
        // before the hallucination guardrail since a partial reply isn't
        // meaningfully "safe" or "unsafe" on the numbers it happens to
        // contain -- it's incomplete regardless.
        deps.logger.error("escalation.triggered", { customerId, reason: "truncated_reply" });
        finalReplyText = fallbackMessage("technicalHiccup", language);
        escalated = true;
        escalationReason = "truncated_reply";
      } else {
        // Stripped before the guardrail check runs, so the guardrail and
        // the customer always see exactly the same text -- see
        // extractEscalationSignal's doc comment for why this is a
        // deterministic signal distinct from the four mechanical triggers
        // above.
        const { text: cleanedReplyText, modelSignaledEscalation } = extractEscalationSignal(reply.text);
        const guardrailResult = checkForUnverifiedNumbers(cleanedReplyText, knowledgeBaseText);
        if (!guardrailResult.safe) {
          deps.logger.error("escalation.triggered", {
            customerId,
            reason: "unverified_numbers_in_reply",
            unverifiedNumbers: guardrailResult.unverifiedNumbers,
          });
          finalReplyText = fallbackMessage("unverifiedNumber", language);
          escalated = true;
          escalationReason = "unverified_numbers_in_reply";
        } else if (modelSignaledEscalation) {
          // The model's own conversational judgment, per the Escalation
          // Rules in the system prompt (a complaint, a discount request, a
          // medical question, a softer wholesale signal) -- its own reply
          // text is exactly right to send (it already explains why,
          // naturally), only the marker is removed.
          deps.logger.error("escalation.triggered", { customerId, reason: "llm_judged_escalation" });
          finalReplyText = cleanedReplyText;
          escalated = true;
          escalationReason = "llm_judged_escalation";
        } else {
          finalReplyText = cleanedReplyText;
          escalated = false;
          escalationReason = null;
        }
      }
    }

    await deps.messageSender.sendReply(customerId, splitIntoMessages(finalReplyText));

    if (escalated && escalationReason !== null) {
      await notifyManager(deps, { customerId, reason: escalationReason, customerMessage: combinedUserMessage });
    }

    const newTurns: LlmConversationTurn[] = [
      { role: "user", text: combinedUserMessage },
      { role: "assistant", text: finalReplyText },
    ];
    const updatedHistory: LlmConversationTurn[] = [...history, ...newTurns].slice(-MAX_HISTORY_TURNS);

    try {
      await deps.conversationStateRepository.save(
        {
          conversationId,
          currentIntent: state?.currentIntent ?? null,
          orderDraft: state?.orderDraft ?? {},
          currentStep: state?.currentStep ?? null,
          pendingClarification: state?.pendingClarification ?? null,
          escalationFlag: escalated,
          variables: { history: updatedHistory } satisfies StoredHistory,
        },
        now,
        DEFAULT_CONVERSATION_STATE_TTL_MS
      );
    } catch (error) {
      // The customer already received a reply above -- a save failure
      // here only means this turn's history won't carry into the next
      // one (a degraded-but-recoverable outcome), not a reason to send a
      // second, confusing message on top of a reply that already went out
      // successfully.
      deps.logger.error("conversation.state_save_failed", { customerId, error: (error as Error).message });
    }
  };
}

/**
 * A real Nuteco reply is a couple of short bubbles at most -- this bounds
 * how many separate Telegram messages one reply can ever become, so a
 * model that over-fragments (or a knowledge-base answer with many blank
 * lines) can't turn into a burst of five-plus messages, which would read
 * as spammy regardless of how short each individual line is.
 */
const MAX_MESSAGE_SEGMENTS = 4;

/**
 * Splits a reply on blank-line boundaries into separate Telegram messages --
 * matching real Nuteco staff style (several short consecutive messages
 * rather than one dense block; see the system prompt's Formatting section,
 * which explicitly tells the model a blank line becomes a separate
 * message). Without this, that instruction had no effect: MessageSender
 * already supported sending multiple messages, but this was the only
 * caller, and it always passed a single-element array.
 */
function splitIntoMessages(text: string): string[] {
  const segments = text
    .split(/\n\s*\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return [text];
  }
  if (segments.length <= MAX_MESSAGE_SEGMENTS) {
    return segments;
  }
  // Over the cap: keep the first few segments as their own messages, and
  // fold everything past the cap back into the last one rather than
  // silently dropping content.
  const head = segments.slice(0, MAX_MESSAGE_SEGMENTS - 1);
  const tail = segments.slice(MAX_MESSAGE_SEGMENTS - 1).join("\n\n");
  return [...head, tail];
}

function extractHistory(variables: Record<string, unknown> | undefined): LlmConversationTurn[] {
  const stored = variables?.history;
  if (!Array.isArray(stored)) return [];
  return stored as LlmConversationTurn[];
}
