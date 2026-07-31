/** Replying to a customer, without the caller knowing which platform they're on. */
export interface MessageSender {
  /** No-op on platforms without a typing indicator. */
  sendTyping(customerId: string): Promise<void>;

  /**
   * Sends `messages` in order. How a reply is split into bubbles is the
   * caller's decision; implementations only handle platform limits
   * (message length, rate limiting).
   */
  sendReply(customerId: string, messages: string[]): Promise<void>;
}
