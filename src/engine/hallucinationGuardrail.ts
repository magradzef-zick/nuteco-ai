/**
 * Catches the assistant stating a price or quantity the knowledge base
 * doesn't back. Runs after generation, before sending; a failure means
 * escalate instead of replying. Telling the model not to hallucinate is
 * necessary but not sufficient -- it can still slip on any given turn.
 *
 * A number verifies only if it appears in a matching context category and
 * the knowledge base doesn't mark that occurrence as not-quotable.
 * payment.md and delivery.md both hold numbers that would otherwise
 * "verify" the same digits used for something else entirely.
 *
 * Scope: only price/percentage/quantity-shaped numbers, not a general
 * fact-checker. Context matching is a fixed keyword taxonomy over a
 * fixed-radius window, so it reduces rather than eliminates the risk of a
 * coincidental digit match. priceCatalog.ts is the stricter third layer
 * for catalogue prices, run from here and folded into the same result.
 */

import { findMisattributedPrices, parsePriceCatalog } from "./priceCatalog";

const NUMBER_PATTERNS: RegExp[] = [
  // "150.000", "1.200.000" -- the price list's own format.
  /\b\d{1,3}(?:\.\d{3})+\b/g,
  // The same amounts with other separators. Without these a reformatted
  // price is a number this check never looks at -- the opposite of failing safe.
  /\b\d{1,3}(?:[ \u00A0,]\d{3})+\b/g,
  // "150000" -- the spreadsheet's own format, so the likeliest echo.
  /\b\d{4,7}\b/g,
  // Percentages, e.g. "12%", "4.5%".
  /\b\d+(?:[.,]\d+)?\s?%/g,
  // A number followed by a unit this business uses, Russian or English.
  /\b\d+(?:[.,]\d+)?\s?(?:кг|гр?|шт|л|микрон\w*|месяц\w*|kg|g|month\w*|day\w*|pcs?)\b/gi,
];

/** Characters each side that count as "nearby" context. A fixed radius, not a sentence parse -- cutting mid-word doesn't matter for keyword presence. */
const CONTEXT_WINDOW_RADIUS = 100;

/** Phrases the knowledge base uses to mark a figure as historical or illustrative rather than quotable. */
const NON_QUOTABLE_MARKERS: RegExp[] = [
  /do not quote/i,
  /not (?:a )?confirmed/i,
  /needs client confirmation/i,
  /no consistent/i,
  /not authoritative/i,
  /provisional/i,
];

/**
 * What a number is "about". Bilingual because replies are Russian/Uzbek
 * while the knowledge base is English with Russian product names, so
 * verification can't rely on word-for-word overlap.
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
      // \b finds no boundary next to Cyrillic (see b2bDetector.ts).
      // "ндс" is rare enough that plain substring matching is fine here.
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
 * An amount named as money, however small. The patterns above skip runs
 * under four digits because most short numbers are quantities -- but
 * "800 сум" is a price claim and has to be checked like any other.
 */
const CURRENCY_AMOUNT_PATTERN = /(?<!\d)(\d{1,3}(?:[ \u00A0.,]\d{3})*)\s?(?:сум|сўм|so'm|som|sum)(?![a-zа-яё])/gi;

/** Every number-like token in `text`, deduplicated, in first-seen order. */
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

/** Every legitimate spelling of an amount, so a reformatted price ("25 000" for "25.000") is still checked. */
function writtenVariantsOf(claim: string): string[] {
  const digits = claim.replace(/\D/g, "");
  if (digits.length < 4 || !/^[\d.,\s ]+$/.test(claim)) {
    return [claim];
  }
  const grouped = (separator: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return [...new Set([claim, digits, grouped("."), grouped(" "), grouped(","), grouped(" ")])];
}

/**
 * Verifies if some non-disclaimed occurrence shares a context category with
 * the reply's usage. An unrecognizable reply context falls back to plain
 * presence, so ordinary uncategorizable numbers don't false-positive.
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
 * Every price/quantity-like number in `reply`, checked against the exact
 * text the model was given this turn -- present *and* in a matching
 * context, not merely present. An empty result means the reply is safe.
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

  // Presence alone is far too weak with a real price list loaded: every
  // catalogue price is a real number in a product context. See priceCatalog.ts.
  const misattributed = findMisattributedPrices(reply, claims, parsePriceCatalog(knowledgeBaseContext));

  const unverifiedNumbers = [...new Set([...unverified, ...misattributed])];

  return {
    safe: unverifiedNumbers.length === 0,
    unverifiedNumbers,
  };
}
