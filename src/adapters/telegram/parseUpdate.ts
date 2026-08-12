import type { InboundMessage } from "../../engine/MessageDebouncer";
import type { ParsedUpdateResult } from "../ParsedUpdateResult";

/**
 * The subset of Telegram's real wire format this project actually reads.
 * Not a full Bot API type definition -- real Telegram payloads have many
 * more fields we simply ignore. Every field here is optional/loosely
 * typed on purpose, because we only trust what we explicitly check for.
 */
/** Telegram's common shape for any attached file. `mime_type` is absent on some types (photos, most video notes) -- see DEFAULT_MIME_TYPES. */
interface TelegramFile {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number };
  /** The message's sender. Absent only for channel posts (not read by this project) -- always present on a private-chat message. */
  from?: { username?: string; first_name?: string; last_name?: string };
  text?: string;
  /** The text a customer typed *alongside* an attachment. Telegram puts it here, not in `text` -- see extractText. */
  caption?: string;
  /** Telegram sends every photo as an array of progressively larger renderings of the same image, smallest first -- see detectMedia. */
  photo?: TelegramFile[];
  voice?: TelegramFile;
  video_note?: TelegramFile;
  video?: TelegramFile;
  sticker?: TelegramFile;
  location?: { latitude: number; longitude: number };
  contact?: { phone_number: string };
  document?: TelegramFile;
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
  /** See NormalizedMessage.ts. Telegram's opaque handle for this message's attachment, or null when there's nothing downloadable (plain text, a location, a contact card, a sticker). */
  mediaFileId: string | null;
  /** See NormalizedMessage.ts. Only ever set alongside mediaFileId. */
  mediaMimeType: string | null;
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
  const media = detectMedia(message);

  const normalized: NormalizedTelegramMessage = {
    platform: "telegram",
    customerId,
    chatId,
    telegramMessageId: message.message_id,
    text: extractText(message),
    mediaType: media.mediaType,
    mediaFileId: media.fileId,
    mediaMimeType: media.mimeType,
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
 * Telegram puts the words a customer typed next to an attachment in
 * `caption`, never in `text` -- so reading `text` alone silently discarded
 * the actual question on every photo, video and document ever sent ("это у
 * вас есть?" attached to a product photo arrived as no text at all). The
 * two are mutually exclusive on a real message, so this is a fallback
 * chain rather than a merge.
 */
function extractText(message: TelegramMessage): string | null {
  return message.text ?? message.caption ?? extractStructuredText(message);
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

/**
 * What Telegram omits rather than sends. A photo is always re-encoded to
 * JPEG by Telegram itself, a voice message is always OGG/Opus, and a video
 * note is always MP4 -- all three arrive with no `mime_type` field at all,
 * so the type is known from *which* field carried the file, not from the
 * payload. Types not listed here (video, document) do send a real
 * `mime_type`, and guessing one for them would be worse than using theirs.
 */
const DEFAULT_MIME_TYPES: Partial<Record<TelegramMediaType, string>> = {
  photo: "image/jpeg",
  voice: "audio/ogg",
  video_note: "video/mp4",
};

/**
 * Which media a message carries and -- for the kinds whose content the
 * assistant can actually read -- the handle needed to download it.
 *
 * `fileId` stays null for location, contact and sticker even though the
 * first two are real message types and the last is a real file: a location
 * and a contact are already surfaced as text (see extractStructuredText),
 * and a sticker is a reaction rather than a question. Downloading any of
 * them would spend a model call to learn nothing.
 */
function detectMedia(message: TelegramMessage): {
  mediaType: TelegramMediaType | null;
  fileId: string | null;
  mimeType: string | null;
} {
  // Telegram sends a photo as several sizes of the same image, ordered
  // smallest to largest. The last is the highest resolution available,
  // which is the one worth showing a vision model -- a thumbnail is often
  // too small to read a label or a screenshot of a price list.
  const file =
    message.photo?.[message.photo.length - 1] ??
    message.voice ??
    message.video_note ??
    message.video ??
    message.document ??
    null;

  const mediaType = detectMediaType(message);
  if (file === null || mediaType === null) {
    return { mediaType, fileId: null, mimeType: null };
  }

  return {
    mediaType,
    fileId: file.file_id,
    mimeType: file.mime_type ?? DEFAULT_MIME_TYPES[mediaType] ?? null,
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
