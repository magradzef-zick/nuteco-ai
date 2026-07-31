/**
 * A deterministic check that a price the assistant states actually belongs
 * to the product (and the size) it is stating it for.
 *
 * Why this exists on top of `hallucinationGuardrail.ts`: that check asks
 * "does this number appear anywhere in the knowledge base, in a roughly
 * matching context category?". Once the client's real price list is in the
 * knowledge base, that question is far too weak -- every price in the
 * catalogue is a real number in a "product" context, so quoting the
 * hazelnut paste price for pistachio paste, or the 1 kg price for a 500 g
 * jar, passes it cleanly. Those are exactly the mistakes that cost this
 * business money.
 *
 * The catalogue is parsed out of the knowledge-base text that was injected
 * into the model for this same turn -- deliberately not from a second,
 * separately-maintained copy. Editing `knowledge/prices.md` therefore moves
 * the prompt and this check together, with no redeploy and no way for the
 * two to drift apart.
 *
 * Products are matched by whole inflected words, and where several
 * catalogue lines match, the longest name wins -- so "арахисовая паста без
 * мёда" is held to its own 23.000 and never allowed the 25.000 of the line
 * with honey.
 *
 * When a reply names no catalogue product at all, this check abstains and
 * leaves the number to the generic guardrail. Abstaining is the right
 * default there: a false escalation is a real cost too, and a number with
 * no product attached is not a catalogue claim.
 */

/** Below this, a spreadsheet cell holds a size or a footnote marker rather than a price (the cheapest real line is 20.000). */
const MIN_PRICE_VALUE = 1000;

/** A stem this short would match half the catalogue; three characters is the floor that still lets "чиа" work. */
const MIN_STEM_LENGTH = 3;

/**
 * How many catalogue lines a stem may appear in and still count as
 * identifying a specific product. "пас" (paste) occurs in over a dozen
 * lines and identifies nothing; "тахи" occurs in one and identifies that
 * line on its own.
 */
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
  /** Every packing size the price list sells anything in, so a stated size can be told apart from an order quantity. */
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

/**
 * Truncates a word so ordinary Russian inflection doesn't break matching:
 * "миндальная"/"миндальной"/"миндальную" all reduce to a common prefix,
 * while "миндальная" and "миндаль" (a different catalogue line) stay
 * distinct.
 */
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
 * How much longer than its stem a word may be and still be the same word.
 * Russian inflection adds an ending, not a new root -- "фисташковая" is
 * "фисташков" plus two letters. Without this bound, stems match by bare
 * substring and "арахис" (the crushed-peanut line, stem "арах") silently
 * matches "арахисовая" (the paste and flour lines), so a price from one is
 * accepted for the other.
 */
const MAX_INFLECTION_LENGTH = 3;

/** Whether `word` is an inflected form of `stem` -- same root, ordinary ending, not a longer different word. */
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
 * Extracts every price table from the knowledge-base text. A table counts
 * as a price table only if all of its header columns after the first are
 * size labels ("200 гр", "1 кг") -- which is what makes this safe to run
 * over the whole knowledge base rather than one designated file: the
 * product/notes table in `products.md` and the payment-methods table in
 * `delivery.md` have prose headers and are ignored.
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

    // A row whose every cell is a dash is kept, not dropped: it is a
    // product the price list names and deliberately gives no price for
    // (soy lecithin, marzipan). Keeping it is what lets a price attached
    // to it be recognized as invented rather than simply unrecognized.
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
 * Catalogue lines the given text names.
 *
 * Preference order matters. A full-name match ("арахисовая мука" -> the
 * Арахисовая мука line) is precise, and precision is what makes the size
 * check worth anything -- so when any line matches in full, only those
 * count. Individually, neither "арахисов" nor "мук" identifies anything;
 * together they identify exactly one line, and no single-stem rule can see
 * that.
 *
 * Only when nothing matches in full does this fall back to "one stem
 * specific enough to identify a line on its own" ("тахини"), which is
 * looser but still better than abstaining.
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
 * мёдом" plus "без", so a reply about the honey-free jar matches both lines
 * and would be allowed either line's price -- 23.000 and 25.000 are both
 * real numbers, and quoting the wrong one is exactly the kind of lie this
 * exists to stop. The longer name is the one the reply actually named, so
 * it wins outright. Same for "Миндальная мука" against "Миндальная мука
 * кето".
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
 * The packing size a price on this line refers to.
 *
 * One `size — price` pair per line (the shape the system prompt mandates)
 * is unambiguous. A whole ladder on one line -- "150 гр — 75.000, 500 гр —
 * 225.000, 1 кг — 450.000" -- is too, but not by proximity: the second
 * price sits nearer to the third size than to its own. What actually holds
 * is order. When a line names as many sizes as prices, the n-th price
 * belongs to the n-th size, and that is true of both ways this gets
 * written ("150 гр — 75.000" and "75.000 за 150 гр").
 *
 * Returns every size on the line when the counts don't line up, so a price
 * is still held to the sizes under discussion rather than waved through.
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
 * Returns the subset of `claims` that the reply attributes to a catalogue
 * product they do not belong to -- wrong product, or the right product's
 * price for the wrong size.
 *
 * `claims` are the number-like tokens already extracted from the reply by
 * the hallucination guardrail; this function only judges the ones that look
 * like prices and only when the reply names a catalogue product.
 */
export function findMisattributedPrices(reply: string, claims: string[], catalog: Catalog): string[] {
  if (catalog.entries.length === 0) return [];

  const replyLevelMentions = mentionedEntries(reply, catalog);
  if (replyLevelMentions.length === 0) return [];

  return claims.filter((claim) => {
    const digits = canonicalNumber(claim);
    if (digits.length === 0) return false;
    // A claim carrying a unit ("2 кг", "4 months") is a quantity, not a price.
    // Everything else that reached here is price-shaped, at any magnitude:
    // an invented "800 сум" is as much a lie as an invented "800.000".
    if (/[a-zа-яё%]/i.test(claim)) return false;

    // Every occurrence is judged, not just the first: a price ladder that
    // states one size correctly and repeats the same figure for a second,
    // wrong size must still be caught.
    for (let from = 0; ; ) {
      const claimIndex = reply.indexOf(claim, from);
      if (claimIndex === -1) break;
      from = claimIndex + claim.length;

      const { line, offsetInLine } = lineContaining(reply, claimIndex);
      // A multi-item reply (an order summary, two products compared) names
      // a different product on each line -- when this line names one, judge
      // this price against that product alone rather than against the union
      // of everything the whole reply mentions, which would let each
      // product's price stand in for the other's.
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
