import type { DetectedLanguage } from "./languageDetector";

/**
 * Every customer-facing message `ConversationEngine.ts` sends without
 * going through Gemini -- media fallback, a blocked/impossible reply, an
 * unreachable LLM, an unreachable store, a deterministic B2B match. None
 * of these paths touch the model, so they can't rely on the system
 * prompt's "reply in the customer's language" instruction. Every message
 * here is trilingual (the three languages this business actually serves)
 * and reason-specific -- a customer should understand *why* the assistant
 * stopped, not just that it did.
 *
 * Wording is deliberately plain and short, modeled on real Nuteco manager
 * phrasing rather than a generic "I want to make sure you get the right
 * information" register.
 */

export type FallbackReason =
  | "mediaFallback"
  | "mediaUnreadable"
  | "unverifiedNumber"
  | "b2bEscalation"
  | "technicalHiccup";

type FallbackMessageSet = Record<FallbackReason, Record<DetectedLanguage, string>>;

export const FALLBACK_MESSAGES: FallbackMessageSet = {
  // Media whose content there is nothing to read: a sticker, or any
  // platform whose adapter can't download attachments (Instagram today).
  // Voice, photo, video and documents no longer land here on Telegram --
  // they go to the model with the file attached; see ConversationEngine.
  mediaFallback: {
    ru: "Пока не могу открыть это вложение — опишите, пожалуйста, текстом 😊",
    uz: "Bu biriktirmani hozircha ocholmayman — matn bilan yozib yuborsangiz boʻladimi?",
    en: "I can't open this attachment — could you describe it in text?",
  },
  // The file *was* meant to be read but couldn't be: too large for the
  // model, a download that failed, an unsupported format. Deliberately
  // does not ask the customer to retype it -- a manager is being notified
  // and gets the original forwarded to them, so the honest thing to say is
  // that a human is picking it up, not that the customer must do the work
  // again.
  mediaUnreadable: {
    ru: "Не смог открыть файл — передал менеджеру, он посмотрит и ответит 😊",
    uz: "Faylni ocholmadim — menejerga uzatdim, koʻrib javob beradi.",
    en: "I couldn't open that file — I've passed it to our team, they'll take a look and reply.",
  },
  // The hallucination guardrail blocked a reply because it contained a
  // price/quantity/figure not actually confirmed in the knowledge base --
  // the customer should hear "I don't have a confirmed figure, I don't
  // want to guess", not a generic deflection.
  unverifiedNumber: {
    ru: "Точно не скажу, не хочу гадать — уточню у менеджера и напишу 😊",
    uz: "Aniq ayta olmayman, taxmin qilgim yoʻq — menejerdan aniqlab yozaman.",
    en: "I can't say for sure — don't want to guess, let me check with the team and get back to you.",
  },
  // A deterministic B2B/wholesale signal matched -- always escalates,
  // regardless of what the assistant could technically answer.
  b2bEscalation: {
    ru: "Опт и корпоративные — это к менеджеру, сейчас подключу 😊",
    uz: "Optom va korporativ buyurtmalar menejerga — hoziroq ulanaman.",
    en: "Wholesale and business orders go straight to our team — connecting you now.",
  },
  // Shared by every purely-technical failure the customer can't do
  // anything about (the LLM is unreachable, a reply came back truncated,
  // the identity/state store couldn't be read or written) -- these are
  // mechanical hiccups, not "don't know a fact" situations, so the
  // honest, natural thing a real employee says is closer to "that didn't
  // go through, let me sort it out" than a detailed explanation.
  technicalHiccup: {
    ru: "Не получилось ответить — уточню и напишу 😊",
    uz: "Javob chiqmadi — tekshirib yozaman.",
    en: "That didn't go through — let me check and get back to you.",
  },
};

export function fallbackMessage(reason: FallbackReason, language: DetectedLanguage): string {
  return FALLBACK_MESSAGES[reason][language];
}
