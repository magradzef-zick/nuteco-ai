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

  const normalized: NormalizedTelegramMessage = {
    platform: "telegram",
    customerId,
    chatId,
    telegramMessageId: message.message_id,
    text: message.text ?? null,
    mediaType: detectMediaType(message),
    isEdited,
    timestamp: isEdited ? message.edit_date ?? message.date : message.date,
  };

  return {
    customerId,
    messageId,
    sequence: message.message_id,
    payload: normalized,
  };
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
