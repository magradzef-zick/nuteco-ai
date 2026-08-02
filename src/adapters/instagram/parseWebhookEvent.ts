import type { InboundMessage } from "../../engine/MessageDebouncer";
import type { ParsedUpdateResult } from "../ParsedUpdateResult";

/**
 * The subset of Meta's real Instagram messaging webhook wire format this
 * project actually reads. Not a full Graph API type definition -- real
 * payloads have many more fields we simply ignore. Every field here is
 * optional/loosely typed on purpose, the same convention as
 * telegram/parseUpdate.ts's TelegramMessage.
 */
interface InstagramAttachment {
  type?: string;
}

interface InstagramMessagingMessage {
  mid: string;
  text?: string;
  /** True only on a message the page itself sent, echoed back by the webhook -- see the is_echo check below. */
  is_echo?: boolean;
  attachments?: InstagramAttachment[];
  /** Present when this references one of this business's own Stories -- a tap-to-react sends this with no `text` and no `attachments` at all, which is why that case needs its own check below rather than falling into the generic media/voice fallback. */
  reply_to?: { story?: unknown };
}

interface InstagramMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: InstagramMessagingMessage;
  read?: unknown;
  reaction?: unknown;
  postback?: unknown;
}

interface InstagramEntry {
  id: string;
  time: number;
  messaging?: InstagramMessagingEvent[];
}

interface InstagramWebhookPayload {
  object?: string;
  entry?: InstagramEntry[];
}

export type InstagramMediaType = "image" | "audio" | "video" | "file" | "story_mention" | "share" | "other";

export interface NormalizedInstagramMessage {
  platform: "instagram";
  customerId: string;
  senderId: string;
  instagramMessageId: string;
  text: string | null;
  mediaType: InstagramMediaType | null;
  /** Unix milliseconds, from Meta's per-event `timestamp`. */
  timestamp: number;
}

/** Known Instagram messaging-event shapes this project deliberately does not act on yet -- listed so "unsupported" is a documented decision, not a silent gap, matching telegram/parseUpdate.ts's KNOWN_UNSUPPORTED_UPDATE_TYPES convention. */
const KNOWN_UNSUPPORTED_EVENT_TYPES = ["read", "reaction", "postback"] as const;

const KNOWN_MEDIA_TYPES: readonly string[] = ["image", "audio", "video", "file", "story_mention", "share"];

/**
 * Parses a raw Instagram webhook POST body into zero or more
 * ParsedUpdateResults.
 *
 * Unlike Telegram (exactly one update per webhook delivery), Meta can
 * batch several entries and several messaging events into a single
 * webhook POST -- so, unlike telegram/parseUpdate.ts's parseUpdate, this
 * returns an array. The caller (composition.ts's
 * handleIncomingInstagramUpdate) processes each result the same way it
 * would a single Telegram update.
 */
export function parseInstagramWebhookEvent(raw: unknown): ParsedUpdateResult[] {
  const payload = raw as InstagramWebhookPayload;
  const results: ParsedUpdateResult[] = [];

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      results.push(parseMessagingEvent(event));
    }
  }

  return results;
}

function parseMessagingEvent(event: InstagramMessagingEvent): ParsedUpdateResult {
  if (event.message) {
    if (event.message.is_echo) {
      // A message the page itself sent, echoed back by the webhook -- not
      // a customer message. Without this check, every reply this bot
      // sends would loop back in as a new "message" to answer.
      return { kind: "unsupported", updateType: "message_echo" };
    }
    if (isContentless(event.message)) {
      // No text and no attachment -- a tap-to-react on our Story is the
      // known real case (see `reply_to` above), but the check itself
      // doesn't depend on that field: no real customer message (a typed
      // reply, a voice note, a photo) is ever completely empty, so
      // anything this bare has nothing for the assistant to answer.
      // Left to fall through, this used to reach the customer as "I
      // can't listen to voice messages or view photos/videos yet" --
      // nonsensical for someone who just tapped an emoji.
      return { kind: "unsupported", updateType: "contentless_message" };
    }
    return { kind: "message", message: toInboundMessage(event, event.message) };
  }

  for (const eventType of KNOWN_UNSUPPORTED_EVENT_TYPES) {
    if (event[eventType] !== undefined) {
      return { kind: "unsupported", updateType: eventType };
    }
  }

  return { kind: "unsupported", updateType: "unknown" };
}

function toInboundMessage(event: InstagramMessagingEvent, message: InstagramMessagingMessage): InboundMessage {
  const senderId = event.sender.id;
  const customerId = `instagram:${senderId}`;

  const normalized: NormalizedInstagramMessage = {
    platform: "instagram",
    customerId,
    senderId,
    instagramMessageId: message.mid,
    text: message.text ?? null,
    mediaType: detectMediaType(message),
    timestamp: event.timestamp,
  };

  return {
    customerId,
    messageId: `${senderId}:${message.mid}`,
    sequence: event.timestamp,
    payload: normalized,
  };
}

function isContentless(message: InstagramMessagingMessage): boolean {
  return !message.text && (message.attachments?.length ?? 0) === 0;
}

function detectMediaType(message: InstagramMessagingMessage): InstagramMediaType | null {
  const attachmentType = message.attachments?.[0]?.type;
  if (!attachmentType) return null;
  return (KNOWN_MEDIA_TYPES.includes(attachmentType) ? attachmentType : "other") as InstagramMediaType;
}
