import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_MESSAGES, type FallbackReason } from "../src/engine/fallbackMessages";

const LANGUAGES = ["ru", "uz", "en"] as const;

test("every fallback exists in all three languages, with nothing left blank", () => {
  for (const [reason, byLanguage] of Object.entries(FALLBACK_MESSAGES)) {
    for (const language of LANGUAGES) {
      const message = byLanguage[language];
      assert.ok(message && message.trim().length > 0, `${reason}.${language} is missing or empty`);
    }
  }
});

/**
 * These paths only ever run outside working hours -- during them, staff
 * answer Telegram themselves and this engine is never invoked (see
 * composition.ts). A message promising that someone is connecting the
 * customer right now is therefore false whenever it is sent, and it reached
 * real customers in all three languages at once ("сейчас подключу",
 * "hoziroq ulanaman", "connecting you now") before this test existed.
 */
const IMMEDIACY_PROMISES = [
  /сейчас/i,
  /hoziroq/i,
  /\bhozir\b/i,
  /right now/i,
  /\bnow\b/i,
  /подключу/i,
];

test("no fallback promises the customer that a manager is reaching them right now", () => {
  for (const [reason, byLanguage] of Object.entries(FALLBACK_MESSAGES)) {
    for (const language of LANGUAGES) {
      for (const promise of IMMEDIACY_PROMISES) {
        assert.ok(
          !promise.test(byLanguage[language]),
          `${reason}.${language} promises immediate contact (${promise}), but nobody is working when this is sent: ${byLanguage[language]}`
        );
      }
    }
  }
});

/**
 * The same handoff has to mean the same thing in every language -- the
 * failure this guards against was Russian saying "the manager will contact
 * you during working hours" while Uzbek said "our manager is contacting you
 * now", for the same question from the same tester.
 */
test("the wholesale handoff names the working-hours wait in each language, not just in Russian", () => {
  const expected: Record<(typeof LANGUAGES)[number], RegExp> = {
    ru: /в рабочее время/i,
    uz: /ish vaqtida/i,
    en: /working period/i,
  };
  const reason: FallbackReason = "b2bEscalation";

  for (const language of LANGUAGES) {
    assert.match(FALLBACK_MESSAGES[reason][language], expected[language], `${reason}.${language} must state when the manager follows up`);
  }
});
