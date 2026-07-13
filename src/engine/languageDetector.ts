/**
 * Deterministic language detection for the three languages this business
 * actually serves (Russian, Uzbek, English) -- a backstop for cases where
 * Gemini either isn't being asked (a deterministic pre-filter
 * short-circuit) or can't be trusted/reached at all (guardrail block, API
 * outage, store outage). This module exists so every customer-facing
 * message, including ones that never touch the model, can still be
 * chosen in the right language, without depending on Gemini being
 * reachable.
 *
 * Not a general-purpose language identification library -- deliberately
 * scoped to distinguishing exactly the three buckets this business's real
 * conversations contain, using script plus a small set of high-frequency
 * Uzbek word stems. Heavy code-switching mid-conversation is normal for
 * this customer base; this only classifies the current turn's text,
 * matching the system prompt's own "reply in the language of the
 * customer's MOST RECENT message" rule -- not track a language across a
 * whole conversation.
 *
 * Two things worth being deliberate about here:
 * 1. Plain `\b` in a JavaScript regex is defined relative to
 *    `[A-Za-z0-9_]` only and silently never matches next to a Cyrillic
 *    letter. `startsAfterBoundary` below checks the character immediately
 *    before a match manually instead of relying on `\b` around Cyrillic
 *    text.
 * 2. Uzbek is agglutinative -- suffixes attach directly to a word stem
 *    with no separator ("yaxshi" + "misiz" = "yaxshimisiz", "qancha" +
 *    "lik" = "qanchalik"). A whole-word match list (`\bqancha\b`) misses
 *    every suffixed form, which is most real usage. Matching a word STEM
 *    at a left boundary without requiring a right one means a suffix
 *    attached directly after the stem still counts as a match.
 */

export type DetectedLanguage = "ru" | "uz" | "en";

/** Letters that exist in Uzbek Cyrillic but not in Russian -- an unambiguous signal on their own, no boundary logic needed since they never occur in Russian text at all. */
const UZBEK_CYRILLIC_LETTERS = /[ўқғҳЎҚҒҲ]/;

/** High-frequency Uzbek word stems, Cyrillic form -- includes common informal spellings (e.g. "канча" alongside the more correct "қанча", since real typing often substitutes the plain "к"). */
const UZBEK_CYRILLIC_STEMS = [
  "рахмат",
  "яхши",
  "хоп",
  "канча",
  "қанча",
  "нима",
  "борми",
  "бор",
  "йўқ",
  "керак",
  "ассалом",
  "алейкум",
  "булади",
  "бўлади",
  "нечта",
  "бодом",
];

/** High-frequency Uzbek word stems, Latin form. */
const UZBEK_LATIN_STEMS = [
  "rahmat",
  "yaxshi",
  "xop",
  "hop",
  "qancha",
  "nima",
  "bormi",
  "bor",
  "yo'q",
  "yoq",
  "kerak",
  "assalom",
  "alaykum",
  "bo'ladi",
  "boladi",
  "necha",
  "salom",
  "bodom",
  "aka",
  "opa",
];

/**
 * Counts whitespace-separated tokens containing at least one character
 * from `characterClass`, not raw character occurrences -- a single short
 * embedded foreign word (a product name typed in Uzbek/English inside an
 * otherwise Russian sentence, very common in this corpus) must not
 * outweigh a whole Russian sentence just because that one word happens to
 * have more letters than "Есть" does. Word-count dominance, not
 * character-count dominance, is what actually reflects which language the
 * sentence is written in.
 */
function countWordsContaining(text: string, characterClass: string): number {
  const pattern = new RegExp(characterClass, "i");
  return text.split(/\s+/).filter((word) => pattern.test(word)).length;
}

/**
 * True if any of `stems` appears in `text` starting right after a
 * word-separator (or at the start of the string) -- deliberately not
 * requiring a boundary on the right, so a suffix attached directly after
 * the stem ("yaxshi" + "misiz") still counts. This also sidesteps `\b`
 * entirely, which is the correct fix for Cyrillic text (see module doc).
 */
function containsStemAt(text: string, stems: string[]): boolean {
  const lower = text.toLowerCase();
  for (const stem of stems) {
    let from = 0;
    while (true) {
      const index = lower.indexOf(stem, from);
      if (index === -1) break;
      const before = index === 0 ? "" : lower[index - 1];
      if (before === "" || !/[a-zа-яёўқғҳ]/i.test(before)) {
        return true;
      }
      from = index + stem.length;
    }
  }
  return false;
}

/**
 * Classifies `text` as "ru", "uz", or "en". Falls back to "ru" when
 * there's no usable signal at all (empty text, or text with no alphabetic
 * characters) -- Russian is the most common language in this business's
 * customer base, and a wrong default is easy for the customer to correct
 * by simply continuing in their own language. Script dominance is
 * measured in matched Uzbek/other
 * words, not raw character counts -- a single short foreign loanword
 * embedded in an otherwise Russian sentence ("Есть Bodon?") must not flip
 * the whole message's classification just because that one word happens
 * to be in Latin script.
 */
export function detectLanguage(text: string): DetectedLanguage {
  const cyrillicWordCount = countWordsContaining(text, "[а-яёўқғҳ]");
  const latinWordCount = countWordsContaining(text, "[a-z]");

  if (cyrillicWordCount === 0 && latinWordCount === 0) {
    return "ru";
  }

  const hasUzbekCyrillicWord = UZBEK_CYRILLIC_LETTERS.test(text) || containsStemAt(text, UZBEK_CYRILLIC_STEMS);
  const hasUzbekLatinWord = containsStemAt(text, UZBEK_LATIN_STEMS);

  // A recognized Uzbek word/stem is a strong, specific signal regardless
  // of which script has more words overall -- check this before falling
  // back to plain script-dominance.
  if (hasUzbekCyrillicWord || hasUzbekLatinWord) {
    return "uz";
  }

  // Ties (e.g. one short Russian sentence plus one embedded Latin-script
  // product name) resolve to Russian, the documented default for this
  // corpus -- see the module doc comment.
  if (cyrillicWordCount >= latinWordCount) {
    return "ru";
  }

  return "en";
}
