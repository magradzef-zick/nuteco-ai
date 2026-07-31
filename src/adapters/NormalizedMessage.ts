/** What the engine reads out of `InboundMessage.payload`. Each adapter's normalized message is structurally compatible with this. */
export interface NormalizedMessage {
  text: string | null;
  mediaType: string | null;
}
