import type {
  TelegramTransport,
  TelegramReplyKeyboardMarkup,
  DownloadedFile,
} from "../../src/adapters/telegram/TelegramTransport";

export type RecordedCall =
  | { method: "sendMessage"; chatId: number; text: string; replyMarkup?: TelegramReplyKeyboardMarkup; businessConnectionId?: string }
  | { method: "sendChatAction"; chatId: number; action: "typing"; businessConnectionId?: string }
  | { method: "getMe" }
  | { method: "setWebhook"; url: string; secretToken?: string; allowedUpdates?: string[] }
  | { method: "forwardMessage"; toChatId: number; fromChatId: number; messageId: number }
  | { method: "downloadFile"; fileId: string };

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
  downloadFileResult: DownloadedFile = { dataBase64: "ZmFrZS1ieXRlcw==", mimeType: null };
  downloadFileError: Error | null = null;

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramReplyKeyboardMarkup,
    businessConnectionId?: string
  ): Promise<void> {
    this.calls.push({
      method: "sendMessage",
      chatId,
      text,
      ...(replyMarkup ? { replyMarkup } : {}),
      ...(businessConnectionId ? { businessConnectionId } : {}),
    });
  }

  async sendChatAction(chatId: number, action: "typing", businessConnectionId?: string): Promise<void> {
    this.calls.push({ method: "sendChatAction", chatId, action, ...(businessConnectionId ? { businessConnectionId } : {}) });
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    this.calls.push({ method: "getMe" });
    if (this.getMeError) {
      throw this.getMeError;
    }
    return this.getMeResult;
  }

  async setWebhook(url: string, secretToken?: string, allowedUpdates?: string[]): Promise<void> {
    this.calls.push({ method: "setWebhook", url, secretToken, ...(allowedUpdates ? { allowedUpdates } : {}) });
  }

  async forwardMessage(toChatId: number, fromChatId: number, messageId: number): Promise<void> {
    this.calls.push({ method: "forwardMessage", toChatId, fromChatId, messageId });
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    this.calls.push({ method: "downloadFile", fileId });
    if (this.downloadFileError) {
      throw this.downloadFileError;
    }
    return this.downloadFileResult;
  }
}
