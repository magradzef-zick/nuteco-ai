/**
 * Deterministic keyword pre-filter for B2B/wholesale detection, per
 * knowledge/b2b_signals.md's "Strong signals" list (and its "Explicit
 * signals from the customer stating it directly" list) -- a backstop for
 * the LLM's own judgment, not a replacement for it. See that file's own
 * "What this list is NOT for" section: this drives escalation, not full
 * classification, and false positives are explicitly cheap (a human
 * quickly confirms it's retail and moves on), while a false negative
 * (running the retail order-collection flow on a real wholesale buyer) is
 * the expensive failure mode this exists to catch even when the LLM's own
 * judgment misses it on a given turn.
 *
 * Deliberately scoped to only the "strong signals" list -- not the
 * "medium signals" (which require judgment about co-occurrence across a
 * whole conversation) and not company/brand-name detection (which needs
 * entity recognition, not keyword matching). Those remain the LLM's job,
 * with knowledge/b2b_signals.md already injected into its context; this
 * filter exists only to catch the unambiguous cases deterministically,
 * regardless of what the LLM would have said on a given turn.
 *
 * Word-boundary note: plain `\b` in a JavaScript regex is defined relative
 * to `[A-Za-z0-9_]` only -- it silently fails to detect a boundary next to
 * a Cyrillic letter (confirmed directly: `/\bопт\b/i.test("нам нужно
 * опт")` is `false`), which would have made every Cyrillic short-token
 * pattern below never match at all. `wordBoundary()` builds a manual,
 * Unicode-aware boundary instead, using `\p{L}`/`\p{N}` lookarounds so it
 * works the same for Cyrillic and Latin script.
 */

function wordBoundary(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "iu");
}

const STRONG_B2B_SIGNAL_PATTERNS: RegExp[] = [
  // Explicit business/invoicing vocabulary.
  /перечислен\w*/i,
  /счет-фактур\w*|счёт-фактур\w*/i,
  wordBoundary("счет|счёт"),
  /договор\w*/i,
  /доверенност\w*/i,
  wordBoundary("инн"),
  wordBoundary("ндс|nds"),
  /юр\.?\s?лиц\w*/i,
  /реквизит\w*/i,
  wordBoundary("didox"),
  // Business document requests.
  /акт сверки/i,
  wordBoundary("invoice"),
  wordBoundary("contract"),
  // Explicit reseller/business intent.
  /у меня магазин/i,
  /мы\s+(?:кофейня|кондитерская|пекарня)/i,
  wordBoundary("опт(?:ом|овая|овые|овой|а)?"),
  wordBoundary("wholesale"),
  // Explicit direct requests for wholesale/business pricing.
  /оптовую цену|оптовые цены|цены для бизнеса|цена для бизнеса/i,
];

/**
 * Checks `text` (the customer's own message for this turn) against the
 * enumerated strong-signal list. Returns true the moment any one signal is
 * found -- per knowledge/b2b_signals.md, a single strong signal is
 * sufficient on its own, no co-occurrence required.
 */
export function detectStrongB2bSignal(text: string): boolean {
  return STRONG_B2B_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}
