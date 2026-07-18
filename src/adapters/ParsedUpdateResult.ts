import type { InboundMessage } from "../engine/MessageDebouncer";

/**
 * The result of parsing a raw webhook payload from any platform adapter
 * into this project's platform-agnostic shape. Shared by every adapter's
 * parser (see telegram/parseUpdate.ts, instagram/parseWebhookEvent.ts) so
 * composition.ts can dispatch on `.kind` the same way regardless of which
 * platform the raw payload actually came from.
 */
export type ParsedUpdateResult =
  | { kind: "message"; message: InboundMessage }
  | { kind: "unsupported"; updateType: string };
