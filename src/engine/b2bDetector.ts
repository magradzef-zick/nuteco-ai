/**
 * Keyword pre-filter for wholesale detection, from the strong-signals list
 * in knowledge/b2b_signals.md. A backstop for the model's judgment, not a
 * replacement: a false positive costs a human ten seconds, a false
 * negative runs the retail order flow on a wholesale buyer.
 *
 * Strong signals only. Medium signals need co-occurrence across a whole
 * conversation and company names need entity recognition -- both stay the
 * model's job.
 */

/**
 * JavaScript's `\b` is defined over `[A-Za-z0-9_]`, so it finds no
 * boundary next to Cyrillic: `/\bопт\b/i.test("нам нужно опт")` is false.
 * Every Cyrillic pattern below would silently never match. This builds a
 * Unicode-aware boundary instead.
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

/** One strong signal is enough on its own -- no co-occurrence required. */
export function detectStrongB2bSignal(text: string): boolean {
  return STRONG_B2B_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}
