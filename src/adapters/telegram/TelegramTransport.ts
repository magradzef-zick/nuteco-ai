/**
 * The port (interface) for actually talking to Telegram's Bot API.
 * Deliberately minimal -- only the operations this project actually needs
 * (send a message, show typing, verify the bot's own identity at startup,
 * register the webhook URL), not a full wrapper around every Bot API
 * method. Everything above this interface (TelegramMessageSender, startup
 * validation) depends only on this, never on the concrete HTTP
 * implementation -- so tests can supply a fake and never touch the
 * network, the same dependency-inversion pattern used for storage in
 * src/storage/.
 */
export interface TelegramTransport {
  sendMessage(chatId: number, text: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
  /** Confirms the token is valid and returns the bot's own identity. Used only for startup validation. */
  getMe(): Promise<{ id: number; username: string | null }>;
  /** Registers (or re-registers) the webhook URL Telegram should deliver updates to. A one-time deployment step, not called per-message. */
  setWebhook(url: string, secretToken?: string): Promise<void>;
}

/**
 * Thrown when Telegram's API responds with an error (a well-formed HTTP
 * response, just not a successful one) -- as opposed to TelegramNetworkError,
 * which means the request never got a response at all.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

/** Thrown when the request itself failed (network error, timeout, DNS failure, etc.) -- Telegram never responded. */
export class TelegramNetworkError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = "TelegramNetworkError";
  }
}

/**
 * Whether a given failure is worth retrying: a 429 (rate limited) or any
 * 5xx (Telegram's own problem) is; a 4xx other than 429 (bad request, bad
 * token, chat not found) is not -- retrying an invalid request just
 * repeats the same failure.
 */
export function isRetryableApiError(error: TelegramApiError): boolean {
  return error.statusCode === 429 || error.statusCode >= 500;
}
