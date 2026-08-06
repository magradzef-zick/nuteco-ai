/** What the engine reads out of `InboundMessage.payload`. Each adapter's normalized message is structurally compatible with this. */
export interface NormalizedMessage {
  text: string | null;
  mediaType: string | null;
  /**
   * A human-readable identifier for the sender, already resolved by the
   * platform-specific adapter (e.g. "@username" for Telegram) so that
   * platform-agnostic code reading this (ConversationEngine's manager
   * notification) never needs to know which platform produced it -- same
   * principle as `customerId`'s opaque "<platform>:<id>" prefix. Null
   * when the platform gave nothing better than the raw id (a Telegram
   * user with no public username, or a platform whose adapter can't
   * resolve this without an extra network call it doesn't make here).
   */
  senderDisplayName: string | null;
  /** A clickable link to the sender's profile, only ever set alongside `senderDisplayName` and only when the platform's own data made one constructible without an extra network call (e.g. a Telegram `@username` always yields a working `t.me` link; a bare first/last name does not). */
  senderProfileUrl: string | null;
  /** The phone number from a shared contact card. Telegram only -- null on every other platform and on any Telegram message that isn't a contact share. */
  sharedPhoneNumber: string | null;
  /** Coordinates from a shared location. Telegram only -- null on every other platform and on any Telegram message that isn't a location share. */
  sharedLocation: { latitude: number; longitude: number } | null;
}
