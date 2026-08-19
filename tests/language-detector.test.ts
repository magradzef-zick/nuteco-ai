import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "../src/engine/languageDetector";

test("detects plain Russian", () => {
  assert.equal(detectLanguage("Здравствуйте! Есть фисташковая паста?"), "ru");
});

test("detects plain English", () => {
  assert.equal(detectLanguage("Hello, do you have pistachio paste?"), "en");
});

test("detects Uzbek written in Cyrillic script", () => {
  assert.equal(detectLanguage("Ассалому алейкум, канча туради?"), "uz");
});

test("detects Uzbek written in Latin script", () => {
  assert.equal(detectLanguage("Assalomu alaykum, narxi qancha?"), "uz");
});

test("detects Uzbek even with agglutinative suffixes attached to the word stem", () => {
  assert.equal(detectLanguage("yaxshimisiz"), "uz", "'yaxshi' + 'misiz' -- a whole-word match list would miss this");
  assert.equal(detectLanguage("Qanchalik turadi bodom pastasi"), "uz", "'qancha' + 'lik'");
});

test("a single embedded Latin-script product name does not flip a Russian sentence to English (the exact reported production case)", () => {
  assert.equal(detectLanguage("Есть Bodon? Сколько стоит за 1 кг?"), "ru");
});

test("a single embedded Cyrillic word does not flip an English sentence to Russian", () => {
  assert.equal(detectLanguage("Do you have кешью paste?"), "en");
});

test("defaults to Russian for text with no alphabetic content at all", () => {
  assert.equal(detectLanguage(""), "ru");
  assert.equal(detectLanguage("😊👍"), "ru");
  assert.equal(detectLanguage("150.000"), "ru");
});

test("Russian-root words with Uzbek grammatical suffixes and no recognizable Uzbek word stem default to Russian (genuinely ambiguous)", () => {
  // "хам" is a real, ambiguous case on its own -- it's also an ordinary
  // Russian word ("boor/rude person"), so it's deliberately not in the
  // Uzbek marker list; adding it would risk misclassifying genuine
  // Russian sentences. Defaulting to Russian here is correct, not a gap.
  assert.equal(detectLanguage("Договор хам подтвердилмаган"), "ru");
});

/**
 * Uzbek's oʻ/gʻ appear with a modifier letter (ʻ), typographic quotes, a
 * backtick or a plain ASCII quote depending on keyboard and habit, mixed
 * freely within real messages. Treating them as different characters made
 * ordinary Uzbek text match no stem at all and lose to Latin-script
 * dominance -- classified as English, and answered in English.
 */
test("Uzbek is recognized whichever apostrophe-like character it is typed with", () => {
  for (const apostrophe of ["'", "ʻ", "‘", "’", "`"]) {
    assert.equal(detectLanguage(`Yo${apostrophe}q, kerak emas`), "uz", `failed for U+${apostrophe.charCodeAt(0).toString(16)}`);
  }
});

test("this project's own Uzbek fallback text is recognized as Uzbek, not English", () => {
  assert.equal(detectLanguage("Aniq ayta olmayman, taxmin qilgim yoʻq — menejerdan aniqlab yozaman."), "uz");
});
