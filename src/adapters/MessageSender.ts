/**
 * A platform-agnostic way to reply to a customer, regardless of whether
 * they're on Telegram or (once built) Instagram. Whatever consumes this
 * interface -- the eventual conversation engine -- never needs a
 * platform-specific branch; each adapter (e.g. TelegramMessageSender)
 * implements this the same way the storage layer has one interface with
 * multiple implementations (see src/storage/).
 */
export interface MessageSender {
  /** Shows the platform's "typing..." indicator to the customer, if the platform supports one. */
  sendTyping(customerId: string): Promise<void>;

  /**
   * Sends one or more messages to the customer, in order. The number and
   * content of `messages` is decided by the caller (e.g. a future
   * conversation engine choosing to send a price as its own short message)
   * -- this method's job is only to respect the platform's real technical
   * constraints (message length limits, rate limits), not to invent its
   * own opinion about how to split a reply into multiple bubbles.
   */
  sendReply(customerId: string, messages: string[]): Promise<void>;
}
