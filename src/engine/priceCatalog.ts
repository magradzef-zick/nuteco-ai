/**
 * Checks that a price the assistant states belongs to the product and size
 * it claims.
 *
 * hallucinationGuardrail.ts only asks whether a number appears somewhere in
 * the knowledge base. With a real price list in there that is far too weak:
 * every catalogue price is a real number in a product context, so the
 * hazelnut price quoted for pistachio, or the 1 kg price for a 500 g jar,
 * passes it cleanly.
 *
 * The catalogue is parsed out of the same text the model was given, not a
 * second copy, so editing knowledge/prices.md moves both together.
 *
 * Abstains when the reply names no catalogue product -- a number with no
 * product attached isn't a catalogue claim, and false escalations cost too.
 */

/** Below this a cell holds a size or a marker, not a price. Cheapest real line is 20.000. */
const MIN_PRICE_VALUE = 1000;

/** Short enough for "чиа", long enough not to match half the catalogue. */
const MIN_STEM_LENGTH = 3;

/** "пас" occurs in a dozen lines and identifies nothing; "тахи" occurs in one. */
const MAX_LINES_PER_DISCRIMINATIVE_STEM = 3;

export interface CatalogEntry {
  /** Product name exactly as written in the price list. */
  product: string;
  /** Word stems of the product name, used for matching against reply text. */
  stems: string[];
  /** Size in grams -> price, digits only ("25000"). Sizes with no price are absent. */
  pricesBySize: Map<number, string>;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** Stems that identify few enough lines to be worth matching on. */
  discriminativeStems: Set<string>;
  /** Every packing size sold, so a stated size can be told apart from an order quantity. */
  knownSizes: Set<number>;
}

/** Digits only, so "25.000", "25 000", "25,000" and "25000" all compare equal. */
export function canonicalNumber(text: string): string {
  return text.replace(/\D/g, "");
}

/** Normalizes for matching: lowercase, ё -> е (customers and staff spell it both ways). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

/** "миндальная"/"миндальной"/"миндальную" collapse to one prefix; "миндаль" (a different line) stays distinct. */
function stemOf(word: string): string {
  return word.slice(0, Math.max(MIN_STEM_LENGTH, word.length - 2));
}

function wordsOf(text: string): string[] {
  return normalize(text).match(/[a-zа-я]{3,}/g) ?? [];
}

function stemsOf(productName: string): string[] {
  return [...new Set(wordsOf(productName).map(stemOf))];
}

/**
 * Inflection adds an ending, not a new root. Without this bound stems match
 * by bare substring and "арах" (crushed peanut) matches "арахисовая" (the
 * paste and flour lines), letting one line's price vouch for another's.
 */
const MAX_INFLECTION_LENGTH = 3;

/** Whether `word` is an inflected form of `stem` rather than a longer, different word. */
function wordMatchesStem(word: string, stem: string): boolean {
  return word.startsWith(stem) && word.length <= stem.length + MAX_INFLECTION_LENGTH;
}

/** "200 гр" -> 200, "1 кг" -> 1000. Returns null if the label isn't a size. */
function sizeInGrams(label: string): number | null {
  const match = normalize(label).match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|гр|г|g)(?![a-zа-я])/);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const isKilos = match[2] === "кг" || match[2] === "kg";
  return isKilos ? Math.round(amount * 1000) : Math.round(amount);
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

/** A `|---|---|` separator row, which markdown puts between a header and its body. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * A table counts as a price table only if every header column after the
 * first is a size label. That is what makes this safe to run over the whole
 * knowledge base: the prose tables in products.md and delivery.md are
 * ignored.
 */
export function parsePriceCatalog(knowledgeBaseText: string): Catalog {
  const entries: CatalogEntry[] = [];
  const lines = knowledgeBaseText.split("\n");

  let currentSizes: number[] | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (cells === null || cells.length < 2) {
      currentSizes = null;
      continue;
    }
    if (isSeparatorRow(cells)) {
      continue;
    }

    if (currentSizes === null) {
      // Candidate header row: only accept it if every column after the
      // first is a size.
      const sizes = cells.slice(1).map(sizeInGrams);
      if (sizes.every((size): size is number => size !== null)) {
        currentSizes = sizes;
      }
      continue;
    }

    const product = cells[0];
    if (product.length === 0) continue;

    const pricesBySize = new Map<number, string>();
    cells.slice(1).forEach((cell, column) => {
      const size = currentSizes?.[column];
      if (size === undefined) return;
      const digits = canonicalNumber(cell);
      if (digits.length === 0 || Number(digits) < MIN_PRICE_VALUE) return;
      pricesBySize.set(size, digits);
    });

    // An all-dash row is kept: the price list names the product and gives
    // no price for it (lecithin, marzipan). Keeping it lets a price
    // attached to it read as invented rather than merely unrecognized.
    entries.push({ product, stems: stemsOf(product), pricesBySize });
  }

  const linesPerStem = new Map<string, number>();
  for (const entry of entries) {
    for (const stem of entry.stems) {
      linesPerStem.set(stem, (linesPerStem.get(stem) ?? 0) + 1);
    }
  }
  const discriminativeStems = new Set(
    [...linesPerStem.entries()]
      .filter(([, count]) => count <= MAX_LINES_PER_DISCRIMINATIVE_STEM)
      .map(([stem]) => stem)
  );

  const knownSizes = new Set(entries.flatMap((entry) => [...entry.pricesBySize.keys()]));

  return { entries, discriminativeStems, knownSizes };
}

/**
 * Full-name matches win when there are any: neither "арахисов" nor "мук"
 * identifies a line alone, but together they identify exactly one, and no
 * single-stem rule sees that. Falls back to one sufficiently rare stem
 * ("тахини") only when nothing matches in full.
 */
function mentionedEntries(text: string, catalog: Catalog): CatalogEntry[] {
  const words = wordsOf(text);
  const mentions = (stem: string) => words.some((word) => wordMatchesStem(word, stem));

  const fullNameMatches = catalog.entries.filter((entry) => entry.stems.every(mentions));
  if (fullNameMatches.length > 0) {
    return mostSpecific(fullNameMatches);
  }
  return catalog.entries.filter((entry) =>
    entry.stems.some((stem) => catalog.discriminativeStems.has(stem) && mentions(stem))
  );
}

/**
 * Drops any full-name match that another full-name match strictly extends.
 *
 * "Арахисовая паста без мёда" contains every word of "Арахисовая паста с
 * мёдом" plus "без", so a reply about the honey-free jar matches both and
 * would be allowed either price. Both are real numbers; quoting the wrong
 * one is the exact lie this exists to stop. Same for "Миндальная мука"
 * against "Миндальная мука кето".
 */
function mostSpecific(matches: CatalogEntry[]): CatalogEntry[] {
  return matches.filter(
    (entry) =>
      !matches.some(
        (other) =>
          other !== entry &&
          other.stems.length > entry.stems.length &&
          entry.stems.every((stem) => other.stems.includes(stem))
      )
  );
}

/** Every size the line mentions, in the order they appear. */
function sizesOn(line: string): number[] {
  const sizePattern = /(\d+(?:[.,]\d+)?)\s*(кг|kg|гр|г|g)(?![a-zа-я])/g;
  const sizes: number[] = [];
  for (const match of normalize(line).matchAll(sizePattern)) {
    const size = sizeInGrams(match[0]);
    if (size !== null) sizes.push(size);
  }
  return sizes;
}

/** Where each price-shaped number sits on the line, in the order they appear. */
function priceOffsetsOn(line: string): number[] {
  const pricePattern = /\d{1,3}(?:[ \u00A0.,]\d{3})+|\d{4,7}/g;
  return [...line.matchAll(pricePattern)].map((match) => match.index ?? 0);
}

/**
 * Which packing size a price on this line refers to.
 *
 * Pairing by proximity is wrong for a one-line ladder: in "150 гр —
 * 75.000, 500 гр — 225.000" the second price sits nearer the third size
 * than its own. Order holds instead -- with as many sizes as prices, the
 * n-th price belongs to the n-th size, in both "150 гр — 75.000" and
 * "75.000 за 150 гр" wordings.
 *
 * Falls back to every size on the line when the counts disagree, so the
 * price is still checked rather than waved through.
 */
function sizesGoverning(line: string, priceOffset: number): number[] {
  const sizes = sizesOn(line);
  if (sizes.length === 0) return [];

  const priceOffsets = priceOffsetsOn(line);
  if (priceOffsets.length !== sizes.length) return sizes;

  const ordinal = priceOffsets.indexOf(priceOffset);
  return ordinal === -1 ? sizes : [sizes[ordinal]];
}

function lineContaining(text: string, index: number): { line: string; offsetInLine: number } {
  const start = text.lastIndexOf("\n", index) + 1;
  const endMarker = text.indexOf("\n", index);
  const end = endMarker === -1 ? text.length : endMarker;
  return { line: text.slice(start, end), offsetInLine: index - start };
}

/**
 * The subset of `claims` attributed to the wrong product, or to the right
 * product at a size it isn't sold in. `claims` come from the hallucination
 * guardrail's own extraction.
 */
export function findMisattributedPrices(reply: string, claims: string[], catalog: Catalog): string[] {
  if (catalog.entries.length === 0) return [];

  const replyLevelMentions = mentionedEntries(reply, catalog);
  if (replyLevelMentions.length === 0) return [];

  return claims.filter((claim) => {
    const digits = canonicalNumber(claim);
    if (digits.length === 0) return false;
    // A claim with a unit ("2 кг", "4 months") is a quantity. Everything
    // else here is price-shaped at any magnitude: an invented "800 сум" is
    // as much a lie as an invented "800.000".
    if (/[a-zа-яё%]/i.test(claim)) return false;

    // Every occurrence, not just the first: a ladder that states one size
    // correctly and repeats the figure for a wrong one must still be caught.
    for (let from = 0; ; ) {
      const claimIndex = reply.indexOf(claim, from);
      if (claimIndex === -1) break;
      from = claimIndex + claim.length;

      const { line, offsetInLine } = lineContaining(reply, claimIndex);
      // An order summary names a different product per line. Judging against
      // the whole reply's union would let each product's price cover the other.
      const lineLevelMentions = mentionedEntries(line, catalog);
      const mentioned = lineLevelMentions.length > 0 ? lineLevelMentions : replyLevelMentions;

      const sizes = sizesGoverning(line, offsetInLine);
      const soldSizes = sizes.filter((size) => mentioned.some((entry) => entry.pricesBySize.has(size)));

      if (soldSizes.length > 0) {
        // The reply names a product and a real packing for it -- hold the
        // price to what that pairing actually costs.
        const allowed = soldSizes.flatMap((size) =>
          mentioned.map((entry) => entry.pricesBySize.get(size)).filter((price) => price !== undefined)
        );
        if (!allowed.includes(digits)) return true;
        continue;
      }

      if (sizes.some((size) => catalog.knownSizes.has(size))) {
        // A real packing size, but not one this product is sold in -- the
        // price list has a dash there (or, for a product it lists with no
        // price at all, no column). Offering it is the error, whatever
        // number follows.
        return true;
      }

      // No size stated, or only an order quantity rather than a packing
      // ("2 кг"): fall back to "must at least be one of this product's own
      // prices".
      const anyPriceOfMentioned = mentioned.flatMap((entry) => [...entry.pricesBySize.values()]);
      if (!anyPriceOfMentioned.includes(digits)) return true;
    }

    return false;
  });
}
