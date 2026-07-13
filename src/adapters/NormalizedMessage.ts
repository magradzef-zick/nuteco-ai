/**
 * The minimal shape every platform adapter's normalized message provides.
 * This is what the (platform-agnostic) Conversation Engine actually reads
 * out of MessageDebouncer's `InboundMessage.payload` -- which is typed as
 * `unknown` there on purpose, since the debouncer itself doesn't need to
 * know anything about message content, only identity/sequencing.
 *
 * `src/adapters/telegram/parseUpdate.ts`'s `NormalizedTelegramMessage` is
 * structurally compatible with this (it has `text` and `mediaType` fields
 * of these exact shapes) without needing to import it -- matching the
 * project's cross-platform normalized shape (`{ platform, customerId,
 * text, mediaType, timestamp }`). When the Instagram adapter is built,
 * its normalized message type only needs the same two fields to work
 * with the Conversation Engine unchanged.
 */
export interface NormalizedMessage {
  text: string | null;
  mediaType: string | null;
}
