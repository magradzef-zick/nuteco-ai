import type { InboundMessage } from "./MessageDebouncer";
import type { NormalizedMessage } from "../adapters/NormalizedMessage";
import type { MessageSender } from "../adapters/MessageSender";
import { detectLanguage, type DetectedLanguage } from "./languageDetector";
import type { Logger } from "../observability/logger";

/**
 * Replaces the full conversation engine for Instagram, per an explicit
 * sales-team request: until Instagram's own App Review completes, it
 * can't yet serve customers outside the app's own roles, so every
 * Instagram message -- regardless of content -- gets redirected to
 * Telegram (call, message, or the one-click order link) instead of an AI
 * answer. No LLM call, no knowledge base, no order collection, no
 * escalation -- this is a fixed operational template, chosen only by the
 * detected language of the customer's message. Also means Instagram
 * traffic no longer spends any of the shared Gemini quota.
 *
 * Wording is fixed by the client, not independently translated per
 * language -- the Uzbek and English versions carry the same content as
 * the Russian original, not a paraphrase.
 */
const REDIRECT_MESSAGE: Record<DetectedLanguage, string> = {
  ru: `Здравствуйте!
благодарим Вас за интерес к нашей продукции ❤️

заказать наши ореховые пасты и муку можно следующими образами:

📞позвонив нам по номеру +99895 1984626

📲написав нам в телеграм по номеру: +99895 1984626

либо оформить заказ в один клик пройдя по ссылке
https://t.me/NutecoPremium`,
  uz: `Assalomu alaykum!
mahsulotlarimizga qiziqish bildirganingiz uchun rahmat ❤️

yong'oq pastalarimiz va unimizni quyidagi usullar bilan buyurtma qilishingiz mumkin:

📞 +99895 1984626 raqamiga qo'ng'iroq qilib

📲 telegramda shu raqamga yozib: +99895 1984626

yoki quyidagi havola orqali bir bosishda buyurtma bering
https://t.me/NutecoPremium`,
  en: `Hello!
thank you for your interest in our products ❤️

you can order our nut butters and flours:

📞 by calling +99895 1984626

📲 by messaging us on Telegram at: +99895 1984626

or place your order in one click via the link
https://t.me/NutecoPremium`,
};

export interface InstagramRedirectHandlerDependencies {
  messageSender: MessageSender;
  logger: Logger;
  /**
   * Same recipient ConversationEngine already escalates to (the client's
   * one configured manager chat, `telegram:<MANAGER_NOTIFICATION_CHAT_ID>`)
   * -- reused, not a second, separately-maintained ID, per the client's
   * explicit confirmation that this is the same chat.
   */
  managerNotificationRecipientId: string;
}

/** Same shape as ConversationEngine's handleMessages, so composition.ts can plug either one into the same shared debounce/drain core. */
export type MessageHandler = (customerId: string, messages: InboundMessage[]) => Promise<void>;

/**
 * Best-effort, mirrors ConversationEngine's own `notifyManager`: never
 * allowed to affect the customer's own reply, a failure here is logged and
 * swallowed rather than thrown. No LLM call to generate this -- it's a
 * plain, deterministic rendering of the customer's own message, not a
 * summarized digest, so it costs nothing against the (badly
 * quota-constrained) Gemini budget.
 */
async function notifyManagerOfInstagramLead(
  deps: Pick<InstagramRedirectHandlerDependencies, "messageSender" | "managerNotificationRecipientId" | "logger">,
  context: { customerId: string; customerMessage: string }
): Promise<void> {
  const notificationText = [
    "Instagram-лид (авто-редирект в Telegram)",
    `Клиент: ${context.customerId}`,
    `Сообщение: ${context.customerMessage}`,
  ].join("\n");

  try {
    await deps.messageSender.sendReply(deps.managerNotificationRecipientId, [notificationText]);
    deps.logger.info("manager_notification.sent", { customerId: context.customerId, reason: "instagram_redirect" });
  } catch (error) {
    deps.logger.error("manager_notification.failed", {
      customerId: context.customerId,
      reason: "instagram_redirect",
      error: (error as Error).message,
    });
  }
}

export function createInstagramRedirectHandler(deps: InstagramRedirectHandlerDependencies): MessageHandler {
  return async function handleInstagramMessages(customerId, messages) {
    const rawText = messages
      .map((message) => (message.payload as NormalizedMessage).text)
      .filter((text): text is string => text !== null && text.trim().length > 0)
      .join("\n");
    const language = detectLanguage(rawText);

    // Never throws: a send failure here is logged and swallowed, matching
    // ConversationEngine's own rule that handleMessages always resolves
    // normally -- composition.ts's drainBatches only has dead-letter
    // recovery for a genuinely unexpected exception, not an expected,
    // recoverable one like a transient send failure.
    try {
      await deps.messageSender.sendReply(customerId, [REDIRECT_MESSAGE[language]]);
    } catch (error) {
      deps.logger.error("instagram_redirect.send_failed", { customerId, error: (error as Error).message });
    }

    // So staff have visibility into Instagram leads even though the bot
    // itself never has a real conversation with them -- otherwise a
    // customer asking a real question on Instagram gets redirected and
    // nobody at Nuteco ever sees what they actually wanted. A photo/voice
    // message with no text still counts as a lead worth flagging, just
    // with nothing to quote.
    await notifyManagerOfInstagramLead(deps, {
      customerId,
      customerMessage: rawText.length > 0 ? rawText : "[без текста — фото или голосовое]",
    });
  };
}
