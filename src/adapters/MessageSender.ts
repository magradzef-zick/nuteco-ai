/**
 * Requests a one-tap "share your contact/location" quick reply alongside
 * the message, on platforms that support it. A UX shortcut only -- the
 * customer can always just type the phone number or address instead;
 * platforms without this concept (Instagram) silently ignore it.
 */
export interface RequestedInputOptions {
  requestContact?: boolean;
  requestLocation?: boolean;
}

/** Replying to a customer, without the caller knowing which platform they're on. */
export interface MessageSender {
  /** No-op on platforms without a typing indicator. */
  sendTyping(customerId: string): Promise<void>;

  /**
   * Sends `messages` in order. How a reply is split into bubbles is the
   * caller's decision; implementations only handle platform limits
   * (message length, rate limiting).
   */
  sendReply(customerId: string, messages: string[], options?: RequestedInputOptions): Promise<void>;
}
