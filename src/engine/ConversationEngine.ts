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
import { detectRequestedInput } from "./requestedInputDetector";
import { detectLanguage } from "./languageDetector";
import { fallbackMessage } from "./fallbackMessages";
import type { Logger } from "../observability/logger";

/**
 * Platform-agnostic: depends only on the MessageSender, storage and
 * LlmProvider interfaces, never on an adapter.
 *
 * Every failure -- unreachable LLM or store, a truncated reply, a blocked
 * guardrail -- becomes an escalation. The customer always gets a reply,
 * never silence, and `handleMessages` always resolves normally.
 *
 * Fallback paths bypass the LLM, so the prompt's "reply in the customer's
 * language" rule doesn't govern them. They use languageDetector.ts and
 * fallbackMessages.ts instead, which still work when the LLM is down.
 *
 * `escalated` comes from four code-level triggers (B2B keyword, LLM/store
 * failure, truncated reply, guardrail block) or from the model's own
 * judgment, signalled by ESCALATION_MARKER per the prompt's escalation
 * rules and stripped before the customer sees it.
 */

/** Bounded so conversation history contributes a roughly stable, small amount to every prompt -- not unlimited memory. */
const MAX_HISTORY_TURNS = 20;

/** Appended by the model when its own judgment says this turn needs a human. Stripped before sending. */
const ESCALATION_MARKER = "[ESCALATE]";

/** Only recognized as the last thing in the reply, so a quoted occurrence elsewhere isn't misread as the signal. */
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
  /**
   * Best-effort forward of a customer's original message (currently only
   * ever a shared location) to another recipient, so the manager sees
   * Telegram's native map view instead of a text reconstruction of the
   * coordinates. `sourceMessageId` is the opaque id from
   * `InboundMessage.messageId` -- platform-specific by nature (only
   * Telegram implements this), so composition.ts wires it in and this
   * stays the only place ConversationEngine touches it; omitted entirely
   * on a platform/deployment with no such capability, in which case
   * forwarding is silently skipped rather than attempted.
   */
  forwardMessageToRecipient?: (sourceMessageId: string, recipientId: string) => Promise<void>;
}

interface StoredHistory {
  history: LlmConversationTurn[];
}

/**
 * Best-effort manager notification. A failure here is logged and
 * swallowed -- the customer already has their reply. Always Russian: this
 * goes to staff, so the customer-language rule doesn't apply.
 */
async function notifyManager(
  deps: Pick<ConversationEngineDependencies, "messageSender" | "managerNotificationRecipientId" | "logger" | "forwardMessageToRecipient">,
  context: {
    customerId: string;
    reason: string;
    customerMessage: string;
    /** Already resolved by the platform adapter (e.g. "@username" for Telegram) -- see NormalizedMessage.ts. Null when the platform gave nothing better than the raw id. */
    senderDisplayName: string | null;
    senderProfileUrl: string | null;
    /** From orderDraft -- the phone number collected via a shared contact card anywhere in this conversation, if any. */
    sharedPhoneNumber: string | null;
    /** From orderDraft -- the id of the message holding a shared location, if any, forwarded natively rather than described as text. */
    sharedLocationMessageId: string | null;
  }
): Promise<void> {
  // "@username (https://t.me/username)" when both are known; the display
  // name alone when there's no link to give (no public username); the
  // raw customerId as a last resort so the manager always has *something*
  // to identify the customer by.
  const clientLine = context.senderDisplayName
    ? context.senderProfileUrl
      ? `${context.senderDisplayName} (${context.senderProfileUrl})`
      : `${context.senderDisplayName} (${context.customerId})`
    : context.customerId;

  const notificationText = [
    `Эскалация (${context.reason})`,
    `Клиент: ${clientLine}`,
    ...(context.sharedPhoneNumber ? [`Телефон: ${context.sharedPhoneNumber}`] : []),
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

  if (context.sharedLocationMessageId && deps.forwardMessageToRecipient) {
    try {
      await deps.forwardMessageToRecipient(context.sharedLocationMessageId, deps.managerNotificationRecipientId);
    } catch (error) {
      deps.logger.error("manager_notification.location_forward_failed", {
        customerId: context.customerId,
        error: (error as Error).message,
      });
    }
  }
}

export function createConversationEngine(deps: ConversationEngineDependencies) {
  return async function handleMessages(customerId: string, messages: InboundMessage[]): Promise<void> {
    const now = deps.now();
    const conversationId = customerId; // one conversation per customer, for now

    // Up front, before any I/O that could fail: every fallback below needs
    // a language, including ones that fire before the LLM or the store has
    // been touched -- which is exactly when those are unavailable.
    const rawPayloads = messages.map((message) => message.payload as NormalizedMessage);
    const rawText = rawPayloads
      .map((payload) => payload.text)
      .filter((text): text is string => text !== null && text.trim().length > 0)
      .join("\n");
    const language = detectLanguage(rawText);
    // Every message in this batch is from the same customer, so any one
    // of them carries the same sender identity -- the first is as good as
    // any other.
    const senderDisplayName = rawPayloads[0]?.senderDisplayName ?? null;
    const senderProfileUrl = rawPayloads[0]?.senderProfileUrl ?? null;

    // The most recent shared contact/location in *this* batch, if any --
    // merged with whatever the conversation already had on file once
    // `state` is available below, so a phone shared several turns before
    // handoff still reaches the manager notification.
    const phoneNumbersInBatch = rawPayloads
      .map((payload) => payload.sharedPhoneNumber)
      .filter((phoneNumber): phoneNumber is string => typeof phoneNumber === "string");
    const sharedPhoneInBatch = phoneNumbersInBatch.length > 0 ? phoneNumbersInBatch[phoneNumbersInBatch.length - 1] : null;

    const locationMessagesInBatch = messages.filter((_, index) => Boolean(rawPayloads[index].sharedLocation));
    const sharedLocationMessageIdInBatch =
      locationMessagesInBatch.length > 0 ? locationMessagesInBatch[locationMessagesInBatch.length - 1].messageId : null;

    // Fail closed: an unreachable store means an honest escalation, not
    // silence and not a stateless reply that would quietly reproduce the
    // "forgets what was just said" failure of the earlier prototype.
    try {
      await deps.identityRepository.recordContact(customerId, now);
    } catch (error) {
      deps.logger.error("escalation.triggered", {
        customerId,
        reason: "state_store_unavailable",
        error: (error as Error).message,
      });
      await deps.messageSender.sendReply(customerId, [fallbackMessage("technicalHiccup", language)]);
      await notifyManager(deps, {
        customerId,
        reason: "state_store_unavailable",
        customerMessage: rawText,
        senderDisplayName,
        senderProfileUrl,
        sharedPhoneNumber: sharedPhoneInBatch,
        sharedLocationMessageId: sharedLocationMessageIdInBatch,
      });
      return;
    }

    const textMessages = rawPayloads.filter((payload) => payload.text !== null && payload.text.trim().length > 0);

    if (textMessages.length === 0) {
      // Media-only batch: a deterministic answer exists, no LLM call needed.
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
      await notifyManager(deps, {
        customerId,
        reason: "state_store_unavailable",
        customerMessage: combinedUserMessage,
        senderDisplayName,
        senderProfileUrl,
        sharedPhoneNumber: sharedPhoneInBatch,
        sharedLocationMessageId: sharedLocationMessageIdInBatch,
      });
      return;
    }
    const history = extractHistory(state?.variables);

    // Carries a phone/location shared on an earlier turn forward to
    // whichever later turn actually triggers the manager handoff -- the
    // batch that says "готово" is rarely the same one that shared the
    // contact card a few messages before.
    const previousOrderDraft = state?.orderDraft ?? {};
    const previousPhoneNumber = typeof previousOrderDraft.phoneNumber === "string" ? previousOrderDraft.phoneNumber : null;
    const previousLocationMessageId =
      typeof previousOrderDraft.locationMessageId === "string" ? previousOrderDraft.locationMessageId : null;
    const sharedPhoneNumber = sharedPhoneInBatch ?? previousPhoneNumber;
    const sharedLocationMessageId = sharedLocationMessageIdInBatch ?? previousLocationMessageId;
    const orderDraft: Record<string, unknown> = {
      ...previousOrderDraft,
      ...(sharedPhoneNumber ? { phoneNumber: sharedPhoneNumber } : {}),
      ...(sharedLocationMessageId ? { locationMessageId: sharedLocationMessageId } : {}),
    };

    let finalReplyText: string;
    let escalated: boolean;
    let escalationReason: string | null;

    if (detectStrongB2bSignal(combinedUserMessage)) {
      // Deterministic backstop, no LLM call: a strong signal is unambiguous
      // enough that a model call only adds cost and a chance of missing it.
      // Does not suppress later turns -- nothing tracks human takeover yet.
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
        // An unreachable LLM is expected, not a bug. `reply` staying null
        // routes to the fallback below.
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
        // A reply cut off at the token limit has no continuation coming.
        // Checked before the guardrail: it's incomplete either way.
        deps.logger.error("escalation.triggered", { customerId, reason: "truncated_reply" });
        finalReplyText = fallbackMessage("technicalHiccup", language);
        escalated = true;
        escalationReason = "truncated_reply";
      } else {
        // Stripped before the guardrail runs, so it and the customer see
        // the same text.
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
          // The model's own judgment. Its reply already explains why, so
          // only the marker is removed.
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

    const requestedInput = detectRequestedInput(finalReplyText);
    await deps.messageSender.sendReply(customerId, splitIntoMessages(finalReplyText), {
      requestContact: requestedInput.contact,
      requestLocation: requestedInput.location,
    });

    if (escalated && escalationReason !== null) {
      await notifyManager(deps, {
        customerId,
        reason: escalationReason,
        customerMessage: combinedUserMessage,
        senderDisplayName,
        senderProfileUrl,
        sharedPhoneNumber,
        sharedLocationMessageId,
      });
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
          orderDraft,
          currentStep: state?.currentStep ?? null,
          pendingClarification: state?.pendingClarification ?? null,
          escalationFlag: escalated,
          variables: { history: updatedHistory } satisfies StoredHistory,
        },
        now,
        DEFAULT_CONVERSATION_STATE_TTL_MS
      );
    } catch (error) {
      // The reply already went out. A save failure only costs this turn's
      // history, which isn't worth a second, confusing message.
      deps.logger.error("conversation.state_save_failed", { customerId, error: (error as Error).message });
    }
  };
}

/** A real reply is a couple of bubbles at most; this stops an over-fragmenting model from sending five. */
const MAX_MESSAGE_SEGMENTS = 4;

/**
 * A blank line becomes a separate message, matching how staff actually
 * write and what the prompt's Formatting section tells the model.
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
  // Over the cap: fold the tail into the last message rather than drop it.
  const head = segments.slice(0, MAX_MESSAGE_SEGMENTS - 1);
  const tail = segments.slice(MAX_MESSAGE_SEGMENTS - 1).join("\n\n");
  return [...head, tail];
}

function extractHistory(variables: Record<string, unknown> | undefined): LlmConversationTurn[] {
  const stored = variables?.history;
  if (!Array.isArray(stored)) return [];
  return stored as LlmConversationTurn[];
}
