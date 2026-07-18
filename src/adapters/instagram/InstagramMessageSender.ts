import type { MessageSender } from "../MessageSender";
import type { InstagramTransport } from "./InstagramTransport";

/** Meta's documented hard limit on a single Messenger/Instagram message's text length -- exceeding this is rejected outright by the Graph API, not a stylistic choice. */
const INSTAGRAM_MAX_MESSAGE_LENGTH = 1000;

/** A small pause between consecutive sends to the same recipient -- mirrors TelegramMessageSender.ts's rationale, staying comfortably clear of the Graph API's per-recipient messaging rate limits. */
const DEFAULT_INTER_MESSAGE_DELAY_MS = 350;

export interface InstagramMessageSenderOptions {
  transport: InstagramTransport;
  /** Injectable for tests -- defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  interMessageDelayMs?: number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implements the platform-agnostic MessageSender for Instagram Direct,
 * mirroring TelegramMessageSender.ts's structure and rationale exactly.
 */
export class InstagramMessageSender implements MessageSender {
  private readonly transport: InstagramTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interMessageDelayMs: number;

  constructor(options: InstagramMessageSenderOptions) {
    this.transport = options.transport;
    this.sleep = options.sleep ?? realSleep;
    this.interMessageDelayMs = options.interMessageDelayMs ?? DEFAULT_INTER_MESSAGE_DELAY_MS;
  }

  async sendTyping(customerId: string): Promise<void> {
    const recipientId = parseInstagramRecipientId(customerId);
    await this.transport.sendSenderAction(recipientId, "typing_on");
  }

  async sendReply(customerId: string, messages: string[]): Promise<void> {
    const recipientId = parseInstagramRecipientId(customerId);

    const allChunks = messages.flatMap((message) => splitForInstagramLimit(message));

    for (let i = 0; i < allChunks.length; i++) {
      if (i > 0) {
        await this.sleep(this.interMessageDelayMs);
      }
      await this.transport.sendMessage(recipientId, allChunks[i]);
    }
  }
}

/**
 * "instagram:1234567890" -> "1234567890". Kept as a string throughout,
 * unlike Telegram's numeric chatId -- Instagram-scoped user IDs are large
 * enough that round-tripping through a JS number risks silent precision
 * loss. Throws clearly on any other shape rather than silently sending to
 * the wrong recipient.
 */
export function parseInstagramRecipientId(customerId: string): string {
  const match = /^instagram:(\d+)$/.exec(customerId);
  if (!match) {
    throw new Error(`"${customerId}" is not a valid Instagram customer ID (expected the form "instagram:<recipientId>").`);
  }
  return match[1];
}

/**
 * Splits `text` only if it exceeds the Graph API's hard length limit -- a
 * mechanical safety net, not a stylistic decision about how many bubbles
 * to send, mirroring splitForTelegramLimit exactly.
 */
function splitForInstagramLimit(text: string): string[] {
  if (text.length <= INSTAGRAM_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += INSTAGRAM_MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(start, start + INSTAGRAM_MAX_MESSAGE_LENGTH));
  }
  return chunks;
}
