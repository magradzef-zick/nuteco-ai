import type { InboundMessage } from "../../engine/MessageDebouncer";
import type { ParsedUpdateResult } from "../ParsedUpdateResult";

/**
 * The subset of Telegram's real wire format this project actually reads.
 * Not a full Bot API type definition -- real Telegram payloads have many
 * more fields we simply ignore. Every field here is optional/loosely
 * typed on purpose, because we only trust what we explicitly check for.
 */
interface TelegramMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number };
  /** The message's sender. Absent only for channel posts (not read by this project) -- always present on a private-chat message. */
  from?: { username?: string; first_name?: string; last_name?: string };
  text?: string;
  photo?: unknown[];
  voice?: unknown;
  video_note?: unknown;
  video?: unknown;
  sticker?: unknown;
  location?: { latitude: number; longitude: number };
  contact?: { phone_number: string };
  document?: unknown;
  /**
   * Present only on a message belonging to a Telegram Business chat (see
   * https://core.telegram.org/bots/api#business-connection) -- the same
   * id must be echoed back on every outgoing Bot API call replying in
   * that chat (sendMessage, sendChatAction), or Telegram rejects it.
   */
  business_connection_id?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  /** A message in a Telegram Business chat -- structurally identical to `message`, just carrying `business_connection_id`. See toInboundMessage. */
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  [otherUpdateType: string]: unknown;
}

export type TelegramMediaType =
  | "photo"
  | "voice"
  | "video_note"
  | "video"
  | "sticker"
  | "location"
  | "contact"
  | "document";

export interface NormalizedTelegramMessage {
  platform: "telegram";
  customerId: string;
  chatId: number;
  telegramMessageId: number;
  text: string | null;
  mediaType: TelegramMediaType | null;
  isEdited: boolean;
  /** Unix seconds, from Telegram's `date` (or `edit_date` for an edited message). */
  timestamp: number;
  /** See NormalizedMessage.ts. "@username" when Telegram gave one -- not every user has one, so this is often null. */
  senderDisplayName: string | null;
  /** See NormalizedMessage.ts. Only ever set alongside senderDisplayName's "@username" form -- a bare first/last name yields no clickable link. */
  senderProfileUrl: string | null;
  /** See NormalizedMessage.ts. Set only when this message is a shared contact card. */
  sharedPhoneNumber: string | null;
  /** See NormalizedMessage.ts. Set only when this message is a shared location. */
  sharedLocation: { latitude: number; longitude: number } | null;
  /** See NormalizedMessage.ts. Set only on a message from a Telegram Business chat (Secretary Mode); null for an ordinary chat. */
  businessConnectionId: string | null;
}

/** Known Telegram update fields this project deliberately does not act on yet -- listed so "unsupported" is a documented decision, not a silent gap. */
const KNOWN_UNSUPPORTED_UPDATE_TYPES = [
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "inline_query",
  "my_chat_member",
  "chat_member",
  // Business-connection lifecycle events (a connection was created,
  // modified, or a business message was deleted) -- not customer
  // messages, so there's nothing here for the conversation engine to
  // reply to. Listed explicitly so they're a documented no-op rather than
  // logged as an unrecognized "unknown" update.
  "business_connection",
  "deleted_business_messages",
];

export function parseUpdate(raw: unknown): ParsedUpdateResult {
  const update = raw as TelegramUpdate;

  if (update.message) {
    return { kind: "message", message: toInboundMessage(update.message, false) };
  }

  if (update.edited_message) {
    return { kind: "message", message: toInboundMessage(update.edited_message, true) };
  }

  // A Telegram Business (Secretary Mode) chat message -- structurally the
  // same Message shape as `message`/`edited_message`, so it reuses the
  // exact same conversation logic; only `business_connection_id` (read in
  // toInboundMessage below) differs, and that's threaded through to every
  // reply so Telegram delivers it via the right business connection.
  if (update.business_message) {
    return { kind: "message", message: toInboundMessage(update.business_message, false) };
  }

  if (update.edited_business_message) {
    return { kind: "message", message: toInboundMessage(update.edited_business_message, true) };
  }

  for (const updateType of KNOWN_UNSUPPORTED_UPDATE_TYPES) {
    if (update[updateType] !== undefined) {
      return { kind: "unsupported", updateType };
    }
  }

  return { kind: "unsupported", updateType: "unknown" };
}

function toInboundMessage(message: TelegramMessage, isEdited: boolean): InboundMessage {
  const chatId = message.chat.id;
  const customerId = `telegram:${chatId}`;
  const messageId = `${chatId}:${message.message_id}`;
  const { senderDisplayName, senderProfileUrl } = describeSender(message.from);

  const normalized: NormalizedTelegramMessage = {
    platform: "telegram",
    customerId,
    chatId,
    telegramMessageId: message.message_id,
    text: message.text ?? extractStructuredText(message),
    mediaType: detectMediaType(message),
    isEdited,
    timestamp: isEdited ? message.edit_date ?? message.date : message.date,
    senderDisplayName,
    senderProfileUrl,
    sharedPhoneNumber: message.contact?.phone_number ?? null,
    sharedLocation: message.location ?? null,
    businessConnectionId: message.business_connection_id ?? null,
  };

  return {
    customerId,
    messageId,
    sequence: message.message_id,
    payload: normalized,
  };
}

/**
 * Prefers `@username` (a real Telegram username is globally unique and
 * always yields a working `t.me/<username>` deep link) over the sender's
 * name -- a username is not guaranteed to exist at all, since it's an
 * optional field a user may never set, in which case there is no reliable
 * way to build a clickable link to them from outside the chat.
 */
function describeSender(from: TelegramMessage["from"]): { senderDisplayName: string | null; senderProfileUrl: string | null } {
  if (from?.username) {
    return { senderDisplayName: `@${from.username}`, senderProfileUrl: `https://t.me/${from.username}` };
  }
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim();
  return { senderDisplayName: name.length > 0 ? name : null, senderProfileUrl: null };
}

/**
 * A shared contact/location arrives as its own message type, not text --
 * but the order-collection flow treats them as equivalent to typing the
 * phone number or address (see system_prompt.md), so surface them as
 * plain text the LLM can read too. Kept free of any RU/UZ/EN words so
 * detectLanguage's word-count heuristic (languageDetector.ts) isn't
 * skewed by which language the assistant happened to ask in.
 */
function extractStructuredText(message: TelegramMessage): string | null {
  if (message.contact) {
    return `📞 ${message.contact.phone_number}`;
  }
  if (message.location) {
    return `📍 ${message.location.latitude}, ${message.location.longitude}`;
  }
  return null;
}

/** The inverse of `messageId = \`${chatId}:${message.message_id}\`` above -- used to forward a customer's original message (e.g. a shared location) by its raw Telegram identity. */
export function parseTelegramMessageId(messageId: string): { chatId: number; telegramMessageId: number } {
  const match = /^(-?\d+):(\d+)$/.exec(messageId);
  if (!match) {
    throw new Error(`"${messageId}" is not a valid Telegram message id (expected the form "<chatId>:<messageId>").`);
  }
  return { chatId: Number(match[1]), telegramMessageId: Number(match[2]) };
}

function detectMediaType(message: TelegramMessage): TelegramMediaType | null {
  if (message.photo) return "photo";
  if (message.voice) return "voice";
  if (message.video_note) return "video_note";
  if (message.video) return "video";
  if (message.sticker) return "sticker";
  if (message.location) return "location";
  if (message.contact) return "contact";
  if (message.document) return "document";
  return null;
}
