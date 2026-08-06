/**
 * Per-send extras that only some platforms understand -- each is silently
 * ignored on a platform without the matching concept (e.g. Instagram
 * ignores all of these).
 */
export interface RequestedInputOptions {
  /** Requests a one-tap "share your contact" quick reply alongside the message. A UX shortcut only -- the customer can always just type the phone number instead. */
  requestContact?: boolean;
  /** Requests a one-tap "share your location" quick reply alongside the message. A UX shortcut only -- the customer can always just type the address instead. */
  requestLocation?: boolean;
  /**
   * Telegram Business (Secretary Mode) only: the connection id the
   * inbound message carried (NormalizedMessage.businessConnectionId).
   * Required on every reply in that chat -- omitted, the send fails.
   */
  businessConnectionId?: string;
}

/** Replying to a customer, without the caller knowing which platform they're on. */
export interface MessageSender {
  /** No-op on platforms without a typing indicator. */
  sendTyping(customerId: string, options?: RequestedInputOptions): Promise<void>;

  /**
   * Sends `messages` in order. How a reply is split into bubbles is the
   * caller's decision; implementations only handle platform limits
   * (message length, rate limiting).
   */
  sendReply(customerId: string, messages: string[], options?: RequestedInputOptions): Promise<void>;
}
