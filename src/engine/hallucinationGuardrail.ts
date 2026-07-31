/**
 * A deterministic, non-LLM safety net against the assistant confidently
 * stating a price, quantity, or other factual number that isn't actually
 * backed by the knowledge base. Telling the model in the system prompt
 * not to hallucinate is necessary but not sufficient on its own -- an LLM
 * can still fail to follow that instruction on any given turn. This check
 * runs AFTER the model generates a reply and BEFORE it is sent to the
 * customer. If it fails, the caller should escalate instead of sending
 * the reply.
 *
 * A number only verifies against a knowledge-base occurrence if:
 * 1. It matches a small, fixed, bilingual context-category taxonomy
 *    (delivery, payment, shelf life, product) -- not just the literal
 *    digits. `knowledge/payment.md` and `knowledge/delivery.md` both
 *    contain numbers that would otherwise "verify" the same digit string
 *    used in a completely different, wrong context.
 * 2. The knowledge base doesn't mark that occurrence with a "don't quote
 *    this precisely" disclaimer (e.g. delivery.md's "Do not quote an
 *    exact delivery fee") -- those never count as verifying.
 *
 * What this does and does not guarantee:
 * - It only checks numbers that look like prices, percentages, or
 *   quantities paired with a unit this business actually uses (kg, g, %,
 *   months, microns...) -- it is not a general fact-checker.
 * - Context matching is a small, fixed keyword taxonomy over a fixed-radius
 *   text window, not real semantic understanding -- it substantially
 *   reduces (does not eliminate) the risk of a number verifying against an
 *   unrelated fact that happens to share the same digits. This is a known,
 *   deliberate scope boundary, not an oversight.
 * - It is one layer, not the only layer -- the system prompt's own
 *   instructions are the first layer, and `priceCatalog.ts` is a third,
 *   stricter one for catalogue prices specifically (right number, wrong
 *   product), which this module runs and folds into the same result.
 */

import { findMisattributedPrices, parsePriceCatalog } from "./priceCatalog";

const NUMBER_PATTERNS: RegExp[] = [
  // Thousand-separated amounts, e.g. "150.000", "1.200.000" -- the format
  // the price list uses and the system prompt tells the model to keep.
  /\b\d{1,3}(?:\.\d{3})+\b/g,
  // The same amounts written with the other separators people actually
  // type -- "150 000", "150 000" (nbsp), "150,000". Without these, a model
  // that simply reformatted a price wrote a number this check never even
  // looked at, which is the opposite of failing safe.
  /\b\d{1,3}(?:[ \u00A0,]\d{3})+\b/g,
  // A bare price-like run of digits, e.g. "150000" -- the format the
  // client's spreadsheet itself uses, so it is exactly what a model is
  // most likely to echo.
  /\b\d{4,7}\b/g,
  // Percentages, e.g. "12%", "4.5%".
  /\b\d+(?:[.,]\d+)?\s?%/g,
  // A number directly followed by a unit word this business actually uses,
  // in Russian or English.
  /\b\d+(?:[.,]\d+)?\s?(?:кг|гр?|шт|л|микрон\w*|месяц\w*|kg|g|month\w*|day\w*|pcs?)\b/gi,
];

/** How many characters of surrounding text (each side) count as "nearby" when checking a number's usage context, in both the reply and the knowledge base. A fixed character radius, not a word/sentence parse -- simple and deterministic, at the cost of occasionally cutting a window mid-word, which doesn't matter for keyword-presence matching. */
const CONTEXT_WINDOW_RADIUS = 100;

/**
 * Phrases the knowledge base itself already uses to mark a nearby figure as
 * an illustrative example or historical data point rather than a
 * currently-quotable fact. If every knowledge-base occurrence of a number
 * is marked this way, the model stating it as a confirmed figure is
 * exactly the failure this guardrail exists to catch.
 */
const NON_QUOTABLE_MARKERS: RegExp[] = [
  /do not quote/i,
  /not (?:a )?confirmed/i,
  /needs client confirmation/i,
  /no consistent/i,
  /not authoritative/i,
  /provisional/i,
];

/**
 * A small, fixed taxonomy of what a number is "about" -- not an exhaustive
 * NLP category system, just enough to distinguish the kinds of facts this
 * business's knowledge base actually contains, bilingually (real replies
 * are usually Russian/Uzbek; the knowledge base is authored in English
 * with Russian product names), so verification isn't only as good as
 * incidental word-for-word overlap between two differently-worded texts.
 */
interface ContextCategory {
  name: string;
  keywords: RegExp[];
}

const CONTEXT_CATEGORIES: ContextCategory[] = [
  {
    name: "delivery",
    keywords: [/доставк\w*/i, /курьер\w*/i, /yandex/i, /почт\w*/i, /\bbts\b/i, /delivery/i, /courier/i, /shipping/i],
  },
  {
    name: "payment",
    keywords: [
      /оплат\w*/i,
      /перечислен\w*/i,
      /наличн\w*/i,
      /карт\w*/i,
      // Plain \b doesn't detect a boundary next to a Cyrillic letter (see
      // b2bDetector.ts's wordBoundary() doc comment for the confirmed
      // failure case) -- "ндс" is short enough that substring matching
      // alone is an acceptable, deliberately simpler alternative here,
      // since it's an uncommon enough sequence not to false-positive.
      /ндс/i,
      /\bnds\b/i,
      /\bvat\b/i,
      /payment/i,
      /\bcash\b/i,
      /\bcard\b/i,
      /invoice/i,
      /счет-фактур\w*/i,
      /счёт-фактур\w*/i,
    ],
  },
  {
    name: "shelf_life",
    keywords: [/срок\s*годност\w*/i, /shelf\s*life/i, /месяц\w*/i, /\bmonths?\b/i, /хранени\w*/i, /refrigerat\w*/i],
  },
  {
    name: "product",
    keywords: [
      /паст\w*/i,
      /мук\w*/i,
      /paste/i,
      /flour/i,
      /миндал\w*/i,
      /almond/i,
      /фисташ\w*/i,
      /pistachio/i,
      /кешью/i,
      /cashew/i,
      /арахис\w*/i,
      /peanut/i,
      /орех\w*/i,
      /walnut/i,
      /кунжут\w*/i,
      /tahini/i,
      /sesame/i,
      /псиллиум/i,
      /psyllium/i,
      /чиа/i,
      /\bchia\b/i,
      /кокос\w*/i,
      /coconut/i,
    ],
  },
];

export interface GuardrailResult {
  safe: boolean;
  /** Numbers found in the reply that could not be verified against the knowledge base. */
  unverifiedNumbers: string[];
}

/**
 * An amount named as money, however short. The patterns above deliberately
 * ignore runs of fewer than four digits, because most short numbers in a
 * reply are quantities -- but "800 сум" is a price claim, and a price claim
 * has to be checked no matter how small the figure. Only the digits are
 * taken, so the amount is compared against the price list the same way any
 * other price is.
 */
const CURRENCY_AMOUNT_PATTERN = /(?<!\d)(\d{1,3}(?:[ \u00A0.,]\d{3})*)\s?(?:сум|сўм|so'm|som|sum)(?![a-zа-яё])/gi;

/**
 * Extracts every number-like token in `text` that matches one of the
 * patterns above, without duplicates, in first-seen order.
 */
function extractNumberClaims(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of NUMBER_PATTERNS) {
    const matches = text.match(pattern) ?? [];
    for (const match of matches) {
      found.add(match.trim());
    }
  }
  for (const match of text.matchAll(CURRENCY_AMOUNT_PATTERN)) {
    found.add(match[1].trim());
  }
  return [...found];
}

function windowAround(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - CONTEXT_WINDOW_RADIUS);
  const end = Math.min(text.length, index + matchLength + CONTEXT_WINDOW_RADIUS);
  return text.slice(start, end);
}

function categoriesFor(text: string): Set<string> {
  const matched = new Set<string>();
  for (const category of CONTEXT_CATEGORIES) {
    if (category.keywords.some((pattern) => pattern.test(text))) {
      matched.add(category.name);
    }
  }
  return matched;
}

function isNonQuotable(window: string): boolean {
  return NON_QUOTABLE_MARKERS.some((pattern) => pattern.test(window));
}

/** Every character index in `text` where `needle` occurs (non-overlapping scan). */
function allIndicesOf(text: string, needle: string): number[] {
  const indices: number[] = [];
  let from = 0;
  while (true) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    indices.push(index);
    from = index + needle.length;
  }
  return indices;
}

/**
 * Every way the same amount can legitimately be written, so that a model
 * which reformatted a price ("25 000" for the price list's "25.000") is
 * still checked against the figure it actually came from instead of
 * sailing past as an unrecognized token. Only applies to pure amounts --
 * anything carrying a unit or a percent sign is matched literally.
 */
function writtenVariantsOf(claim: string): string[] {
  const digits = claim.replace(/\D/g, "");
  if (digits.length < 4 || !/^[\d.,\s ]+$/.test(claim)) {
    return [claim];
  }
  const grouped = (separator: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return [...new Set([claim, digits, grouped("."), grouped(" "), grouped(","), grouped(" ")])];
}

/**
 * A claim verifies if at least one non-disclaimed knowledge-base occurrence
 * of the exact digit string shares a context category with the reply's own
 * usage -- or if the reply's own context gives no recognizable category at
 * all (an ambiguous case that falls back to the original presence check,
 * so as not to introduce new false positives on ordinary, uncategorizable
 * numbers).
 */
function isVerifiedInContext(claim: string, replyWindow: string, knowledgeBaseContext: string): boolean {
  const occurrences = writtenVariantsOf(claim).flatMap((variant) =>
    allIndicesOf(knowledgeBaseContext, variant).map((index) => ({ index, length: variant.length }))
  );
  if (occurrences.length === 0) {
    return false;
  }

  const replyCategories = categoriesFor(replyWindow);

  for (const { index, length } of occurrences) {
    const kbWindow = windowAround(knowledgeBaseContext, index, length);
    if (isNonQuotable(kbWindow)) {
      continue;
    }
    if (replyCategories.size === 0) {
      return true;
    }
    const kbCategories = categoriesFor(kbWindow);
    if ([...replyCategories].some((category) => kbCategories.has(category))) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether every price/quantity-like number in `reply` is both
 * present in `knowledgeBaseContext` (the exact text injected into the
 * model for this turn) and used in a matching context -- not just present
 * anywhere. Returns which numbers, if any, could not be verified -- an
 * empty list means the reply is safe to send.
 */
export function checkForUnverifiedNumbers(
  reply: string,
  knowledgeBaseContext: string
): GuardrailResult {
  const claims = extractNumberClaims(reply);

  const unverified = claims.filter((claim) => {
    const firstIndex = reply.indexOf(claim);
    const replyWindow = firstIndex === -1 ? reply : windowAround(reply, firstIndex, claim.length);
    return !isVerifiedInContext(claim, replyWindow, knowledgeBaseContext);
  });

  // Present-in-the-knowledge-base is necessary but nowhere near sufficient
  // once the real price list is in there: every catalogue price is a real
  // number in a product context, so quoting one product's price for another
  // product, or the 1 kg price for a 500 g jar, passes the check above
  // cleanly. See priceCatalog.ts.
  const misattributed = findMisattributedPrices(reply, claims, parsePriceCatalog(knowledgeBaseContext));

  const unverifiedNumbers = [...new Set([...unverified, ...misattributed])];

  return {
    safe: unverifiedNumbers.length === 0,
    unverifiedNumbers,
  };
}
