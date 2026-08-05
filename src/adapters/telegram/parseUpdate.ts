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
  location?: unknown;
  contact?: unknown;
  document?: unknown;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
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
}

/** Known Telegram update fields this project deliberately does not act on yet -- listed so "unsupported" is a documented decision, not a silent gap. */
const KNOWN_UNSUPPORTED_UPDATE_TYPES = [
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "inline_query",
  "my_chat_member",
  "chat_member",
];

export function parseUpdate(raw: unknown): ParsedUpdateResult {
  const update = raw as TelegramUpdate;

  if (update.message) {
    return { kind: "message", message: toInboundMessage(update.message, false) };
  }

  if (update.edited_message) {
    return { kind: "message", message: toInboundMessage(update.edited_message, true) };
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
    text: message.text ?? null,
    mediaType: detectMediaType(message),
    isEdited,
    timestamp: isEdited ? message.edit_date ?? message.date : message.date,
    senderDisplayName,
    senderProfileUrl,
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
