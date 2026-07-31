/**
 * Picks between Russian, Uzbek and English without asking the model --
 * needed whenever the model isn't consulted or can't be reached, so
 * fallback messages still land in the right language.
 *
 * Not a general language identifier: script plus a short list of frequent
 * Uzbek stems, enough for these three. Classifies the current turn only,
 * matching the prompt's "reply in the language of the most recent
 * message" rule; code-switching mid-conversation is normal here.
 *
 * Two traps:
 * 1. `\b` never matches next to Cyrillic (it's defined over
 *    `[A-Za-z0-9_]`), so `startsAfterBoundary` checks the preceding
 *    character by hand.
 * 2. Uzbek is agglutinative -- "yaxshi" + "misiz" = "yaxshimisiz". Whole-
 *    word matching misses most real usage, so stems match at a left
 *    boundary only, letting a suffix follow directly.
 */

export type DetectedLanguage = "ru" | "uz" | "en";

/** Exist in Uzbek Cyrillic but not Russian, so no boundary logic needed. */
const UZBEK_CYRILLIC_LETTERS = /[ўқғҳЎҚҒҲ]/;

/** Frequent Uzbek stems, Cyrillic. Includes informal spellings ("канча" for "қанча") since people type the plain "к". */
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
 * Defaults to "ru" with no usable signal -- the commonest language here,
 * and a wrong guess costs nothing since the customer just keeps writing.
 * Dominance is counted in words, not characters, so one Latin loanword in
 * a Russian sentence ("Есть Bodon?") can't flip the classification.
 */
export function detectLanguage(text: string): DetectedLanguage {
  const cyrillicWordCount = countWordsContaining(text, "[а-яёўқғҳ]");
  const latinWordCount = countWordsContaining(text, "[a-z]");

  if (cyrillicWordCount === 0 && latinWordCount === 0) {
    return "ru";
  }

  const hasUzbekCyrillicWord = UZBEK_CYRILLIC_LETTERS.test(text) || containsStemAt(text, UZBEK_CYRILLIC_STEMS);
  const hasUzbekLatinWord = containsStemAt(text, UZBEK_LATIN_STEMS);

  // A recognized Uzbek stem beats raw script dominance.
  if (hasUzbekCyrillicWord || hasUzbekLatinWord) {
    return "uz";
  }

  // Ties go to Russian.
  if (cyrillicWordCount >= latinWordCount) {
    return "ru";
  }

  return "en";
}
