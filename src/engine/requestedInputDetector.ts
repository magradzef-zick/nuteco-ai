/**
 * Deterministic keyword check on the assistant's own outgoing reply text:
 * is this turn asking the customer for their phone number, their
 * location/delivery address, or both? Drives whether Telegram attaches a
 * one-tap "share contact" / "share location" button (see
 * TelegramMessageSender.ts) -- a UX shortcut only, the customer can
 * always just type it instead.
 *
 * Substring matching, no word-boundary machinery: mirrors b2bDetector.ts's
 * house style. Checked against every knowledge/*.md and prompts/*.md file
 * -- none of these stems ever appear referring to Nuteco's own phone
 * number or address (that content is explicitly blocked pending client
 * input, see knowledge/contacts.md), so there's no realistic false-positive
 * source in this domain.
 */

const CONTACT_REQUEST_PATTERNS: RegExp[] = [/номер/i, /телефон/i, /raqam/i, /telefon/i, /phone/i];

const LOCATION_REQUEST_PATTERNS: RegExp[] = [
  /адрес/i,
  /локац/i,
  /геолокац/i,
  /manzil/i,
  /joylashuv/i,
  /lokatsiya/i,
  /location/i,
  /address/i,
];

export interface RequestedInput {
  contact: boolean;
  location: boolean;
}

export function detectRequestedInput(replyText: string): RequestedInput {
  return {
    contact: CONTACT_REQUEST_PATTERNS.some((pattern) => pattern.test(replyText)),
    location: LOCATION_REQUEST_PATTERNS.some((pattern) => pattern.test(replyText)),
  };
}
