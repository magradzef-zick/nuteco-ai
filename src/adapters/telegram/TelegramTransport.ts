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
  /**
   * `businessConnectionId` must be the same id the inbound message carried
   * (see NormalizedTelegramMessage.businessConnectionId) when replying in
   * a Telegram Business chat -- omitted entirely for an ordinary chat.
   */
  sendMessage(chatId: number, text: string, replyMarkup?: TelegramReplyKeyboardMarkup, businessConnectionId?: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing", businessConnectionId?: string): Promise<void>;
  /** Confirms the token is valid and returns the bot's own identity. Used only for startup validation. */
  getMe(): Promise<{ id: number; username: string | null }>;
  /** Registers (or re-registers) the webhook URL Telegram should deliver updates to. A one-time deployment step, not called per-message. */
  setWebhook(url: string, secretToken?: string, allowedUpdates?: string[]): Promise<void>;
  /** Forwards an existing message (native rendering intact -- e.g. a shared location keeps its interactive map) from one chat to another. */
  forwardMessage(toChatId: number, fromChatId: number, messageId: number): Promise<void>;
  /**
   * Downloads the bytes behind a `file_id` (a voice message, photo,
   * video, document) so they can be handed to the LLM. Telegram never
   * puts the content itself in an update -- only an opaque id -- so this
   * is a two-step call (`getFile` for the path, then a plain GET against
   * the file host) that every media-reading path has to make.
   *
   * Throws TelegramFileTooLargeError above MAX_DOWNLOADABLE_FILE_BYTES,
   * rather than returning an oversized payload the caller would have to
   * re-check.
   */
  downloadFile(fileId: string): Promise<DownloadedFile>;
}

export interface DownloadedFile {
  /** The file's bytes, base64-encoded -- the form every LLM provider's inline-data API expects. */
  dataBase64: string;
  /**
   * From the file host's `Content-Type` response header, when it sent a
   * usable one. Only a fallback: the inbound message's own `mime_type`
   * (see parseUpdate.ts) is more trustworthy and is preferred by the
   * caller. Null when the header was missing.
   */
  mimeType: string | null;
}

/**
 * Two independent ceilings sit above this number, and it has to clear
 * both: Telegram's Bot API refuses to serve `getFile` downloads over
 * 20 MB at all, and Gemini caps a whole inline request at ~20 MB -- into
 * which the same bytes go base64-encoded, i.e. ~33% larger than on disk.
 * 15 MB is the largest round number that leaves room for that inflation
 * plus the prompt and conversation history alongside it.
 *
 * A file over this is not an error to paper over: a phone video easily
 * exceeds it, and there is no way to shrink one here. It escalates to a
 * manager, who gets the original forwarded to them natively.
 */
export const MAX_DOWNLOADABLE_FILE_BYTES = 15 * 1024 * 1024;

/** Thrown when a file exceeds MAX_DOWNLOADABLE_FILE_BYTES -- a normal, expected condition (a phone video), not a bug. Distinct from TelegramApiError so callers can tell "too big to read" from "Telegram rejected the request". */
export class TelegramFileTooLargeError extends Error {
  constructor(public readonly sizeBytes: number) {
    super(
      `Telegram file is ${Math.round(sizeBytes / 1024 / 1024)} MB, over the ${Math.round(
        MAX_DOWNLOADABLE_FILE_BYTES / 1024 / 1024
      )} MB limit this project can pass to the language model.`
    );
    this.name = "TelegramFileTooLargeError";
  }
}

/**
 * Telegram's own `ReplyKeyboardMarkup` shape, restricted to the one-tap
 * "share your contact/location" buttons this project uses -- not a
 * general keyboard builder. `resize_keyboard` keeps it compact instead of
 * full-screen; `one_time_keyboard` hides it again once the customer taps
 * a button (or sends anything else), rather than sitting there forever.
 */
export interface TelegramReplyKeyboardMarkup {
  keyboard: Array<Array<{ text: string; request_contact?: true; request_location?: true }>>;
  resize_keyboard: true;
  one_time_keyboard: true;
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
