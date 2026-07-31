import type { InboundMessage } from "../engine/MessageDebouncer";

/** What every adapter's parser returns, so composition.ts can dispatch on `kind` without caring about the platform. */
export type ParsedUpdateResult =
  | { kind: "message"; message: InboundMessage }
  | { kind: "unsupported"; updateType: string };
