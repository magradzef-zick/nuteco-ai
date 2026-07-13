import type { MessageSender } from "../MessageSender";
import type { TelegramTransport } from "./TelegramTransport";

/** Telegram's hard limit on a single message's text length -- exceeding this is rejected outright by the Bot API, not a stylistic choice. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** A small pause between consecutive sends to the same chat, to stay comfortably under Telegram's ~1 message/second per-chat rate limit. */
const DEFAULT_INTER_MESSAGE_DELAY_MS = 350;

export interface TelegramMessageSenderOptions {
  transport: TelegramTransport;
  /** Injectable for tests -- defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  interMessageDelayMs?: number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implements the platform-agnostic MessageSender for Telegram. Sends
 * plain text only -- no `parse_mode` -- which sidesteps a common,
 * well-known Telegram bot bug: MarkdownV2 requires escaping ordinary
 * punctuation (periods after price numbers, parentheses), and an
 * unescaped character causes the Bot API to reject the send outright.
 */
export class TelegramMessageSender implements MessageSender {
  private readonly transport: TelegramTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interMessageDelayMs: number;

  constructor(options: TelegramMessageSenderOptions) {
    this.transport = options.transport;
    this.sleep = options.sleep ?? realSleep;
    this.interMessageDelayMs = options.interMessageDelayMs ?? DEFAULT_INTER_MESSAGE_DELAY_MS;
  }

  async sendTyping(customerId: string): Promise<void> {
    const chatId = parseTelegramChatId(customerId);
    await this.transport.sendChatAction(chatId, "typing");
  }

  async sendReply(customerId: string, messages: string[]): Promise<void> {
    const chatId = parseTelegramChatId(customerId);

    const allChunks = messages.flatMap((message) => splitForTelegramLimit(message));

    for (let i = 0; i < allChunks.length; i++) {
      if (i > 0) {
        await this.sleep(this.interMessageDelayMs);
      }
      await this.transport.sendMessage(chatId, allChunks[i]);
    }
  }
}

/** "telegram:123456789" -> 123456789. Throws clearly on any other shape rather than silently sending to the wrong chat. */
export function parseTelegramChatId(customerId: string): number {
  const match = /^telegram:(-?\d+)$/.exec(customerId);
  if (!match) {
    throw new Error(
      `"${customerId}" is not a valid Telegram customer ID (expected the form "telegram:<chatId>").`
    );
  }
  return Number(match[1]);
}

/**
 * Splits `text` only if it exceeds Telegram's hard length limit -- a
 * mechanical safety net, not a stylistic decision about how many bubbles
 * to send. Deciding to send a reply as several short, house-style
 * messages is the caller's job (see MessageSender.sendReply's doc
 * comment); this only prevents a single overly long message from being
 * rejected outright.
 */
function splitForTelegramLimit(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += TELEGRAM_MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(start, start + TELEGRAM_MAX_MESSAGE_LENGTH));
  }
  return chunks;
}
