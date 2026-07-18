/**
 * The port (interface) for actually talking to Instagram's messaging API
 * (the Messenger platform surface of Meta's Graph API). Mirrors
 * TelegramTransport.ts's shape and intent: deliberately minimal, only the
 * operations this project actually needs, so everything above this
 * interface (InstagramMessageSender, startup validation) depends only on
 * it, never on the concrete HTTP implementation -- the same
 * dependency-inversion pattern used for storage in src/storage/.
 */
export interface InstagramTransport {
  sendMessage(recipientId: string, text: string): Promise<void>;
  sendSenderAction(recipientId: string, action: "typing_on" | "typing_off"): Promise<void>;
  /** Confirms the page access token is valid and returns the connected account's own identity. Used only for startup validation. */
  getProfile(): Promise<{ id: string; username: string | null }>;
  /**
   * Subscribes the configured Instagram-linked page to receive webhook
   * events for the given fields (e.g. "messages"). A one-time deployment
   * step, not called per-message. Unlike Telegram's setWebhook, this does
   * NOT register the webhook URL itself -- Meta requires the URL (and its
   * verify-token handshake) to be configured once in the App Dashboard's
   * Webhooks product first; see src/scripts/subscribeInstagramWebhook.ts.
   */
  subscribeWebhookFields(fields: string[]): Promise<void>;
}

/**
 * Thrown when the Graph API responds with an error (a well-formed HTTP
 * response, just not a successful one) -- as opposed to
 * InstagramNetworkError, which means the request never got a response at
 * all. Mirrors TelegramApiError / TelegramNetworkError exactly.
 */
export class InstagramApiError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "InstagramApiError";
  }
}

/** Thrown when the request itself failed (network error, timeout, DNS failure, etc.) -- the Graph API never responded. */
export class InstagramNetworkError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = "InstagramNetworkError";
  }
}

/**
 * Whether a given failure is worth retrying: a 429 (rate limited) or any
 * 5xx (Meta's own problem) is; a 4xx other than 429 (bad request, bad
 * token, unknown recipient) is not -- retrying an invalid request just
 * repeats the same failure. Same policy as Telegram's isRetryableApiError.
 */
export function isRetryableApiError(error: InstagramApiError): boolean {
  return error.statusCode === 429 || error.statusCode >= 500;
}
