import type { TelegramTransport, TelegramReplyKeyboardMarkup } from "../../src/adapters/telegram/TelegramTransport";

export type RecordedCall =
  | { method: "sendMessage"; chatId: number; text: string; replyMarkup?: TelegramReplyKeyboardMarkup }
  | { method: "sendChatAction"; chatId: number; action: "typing" }
  | { method: "getMe" }
  | { method: "setWebhook"; url: string; secretToken?: string }
  | { method: "forwardMessage"; toChatId: number; fromChatId: number; messageId: number };

/**
 * A fake TelegramTransport that records every call instead of touching the
 * network. Used by any test that needs a working transport (e.g.
 * TelegramMessageSender, the webhook integration test) without caring
 * about HttpTelegramTransport's own HTTP/retry details -- those have
 * their own dedicated tests.
 */
export class FakeTelegramTransport implements TelegramTransport {
  readonly calls: RecordedCall[] = [];
  getMeResult: { id: number; username: string | null } = { id: 1, username: "nuteco_test_bot" };
  getMeError: Error | null = null;

  async sendMessage(chatId: number, text: string, replyMarkup?: TelegramReplyKeyboardMarkup): Promise<void> {
    this.calls.push({ method: "sendMessage", chatId, text, ...(replyMarkup ? { replyMarkup } : {}) });
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    this.calls.push({ method: "sendChatAction", chatId, action });
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    this.calls.push({ method: "getMe" });
    if (this.getMeError) {
      throw this.getMeError;
    }
    return this.getMeResult;
  }

  async setWebhook(url: string, secretToken?: string): Promise<void> {
    this.calls.push({ method: "setWebhook", url, secretToken });
  }

  async forwardMessage(toChatId: number, fromChatId: number, messageId: number): Promise<void> {
    this.calls.push({ method: "forwardMessage", toChatId, fromChatId, messageId });
  }
}
