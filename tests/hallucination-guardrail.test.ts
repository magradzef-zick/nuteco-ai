import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUnverifiedNumbers } from "../src/engine/hallucinationGuardrail";

test("passes when the only price in the reply is backed by the knowledge base", () => {
  const kb = "Almond flour (white): 150.000 per kg.";
  const reply = "White almond flour is 150.000 per kg.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, true);
  assert.deepEqual(result.unverifiedNumbers, []);
});

test("fails when the reply states a price not present in the knowledge base", () => {
  const kb = "Almond flour (white): 150.000 per kg.";
  const reply = "White almond flour is 200.000 per kg.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, false);
  assert.deepEqual(result.unverifiedNumbers, ["200.000"]);
});

test("catches a fabricated discount percentage", () => {
  const kb = "We never offer discounts without manager approval.";
  const reply = "Sure, I can give you a 15% discount.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, false);
  assert.deepEqual(result.unverifiedNumbers, ["15%"]);
});

test("catches a fabricated shelf-life quantity claim", () => {
  const kb = "Shelf life: pastes 4 months, flours 6 months.";
  const reply = "This paste stays fresh for 12 months.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, false);
  assert.ok(result.unverifiedNumbers.includes("12 months"));
});

test("passes a shelf-life claim that is actually in the knowledge base", () => {
  const kb = "Shelf life: pastes 4 months, flours 6 months.";
  const reply = "Our pastes stay fresh for 4 months.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, true);
});

test("does not flag ordinary numbers that are not prices/quantities (low false-positive risk)", () => {
  const kb = "We are open Monday to Friday.";
  const reply = "I can help with that in just a moment.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, true);
});

test("does NOT verify a number against the knowledge base when it appears there in an unrelated context (bare substring presence is not enough)", () => {
  const kb = "Delivery within Tashkent typically costs around 25.000 sum via courier, depending on distance.";
  const reply = "Миндальная мука стоит 25.000 сум за кг.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, false);
  assert.deepEqual(result.unverifiedNumbers, ["25.000"]);
});

test("still verifies a number when the reply and knowledge base share a real context category (e.g. both about delivery)", () => {
  const kb = "Delivery within Tashkent typically costs around 25.000 sum via courier, depending on distance.";
  const reply = "Доставка по Ташкенту обычно стоит около 25.000 сум.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, true);
});

test("does NOT verify a number the knowledge base itself marks as not quotable, even if the category matches", () => {
  const kb = "Do not quote an exact delivery fee. Real historical fees ranged from 25.000 to 82.000 sum, with no consistent formula.";
  const reply = "Доставка стоит 25.000 сум.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, false);
  assert.deepEqual(result.unverifiedNumbers, ["25.000"]);
});

test("catches multiple unverified numbers in one reply", () => {
  const kb = "Almond flour: 150.000 per kg.";
  const reply = "Almond flour is 150.000 per kg, and pistachio paste is 500.000 per kg.";

  const result = checkForUnverifiedNumbers(reply, kb);

  assert.equal(result.safe, false);
  assert.deepEqual(result.unverifiedNumbers, ["500.000"]);
});

/**
 * The knowledge base is Russian throughout, so a size in it is always
 * Cyrillic ("1 кг"). A correct Uzbek reply writes the same size in Latin
 * ("1 kg"), and a literal lookup of one never finds the other -- which
 * withheld essentially every Uzbek price answer as "unverified" and sent
 * the customer "I can't say for sure" instead of a price the knowledge base
 * plainly contained.
 */
test("a size written in Latin verifies against the same size written in Cyrillic", () => {
  const knowledgeBase = "Фисташковая паста: 200 гр — 100.000, 1 кг — 450.000.";

  const uzbek = checkForUnverifiedNumbers("Pista pastasi 1 kg — 450.000 so'm", knowledgeBase);
  assert.deepEqual(uzbek.unverifiedNumbers, []);
  assert.equal(uzbek.safe, true);

  const grams = checkForUnverifiedNumbers("200 gr — 100.000 so'm", knowledgeBase);
  assert.equal(grams.safe, true, "\"200 gr\" is the same claim as \"200 гр\"");
});

test("matching units across scripts does not wave through a size the knowledge base never states", () => {
  const knowledgeBase = "Фисташковая паста: 200 гр — 100.000, 1 кг — 450.000.";

  const invented = checkForUnverifiedNumbers("Pista pastasi 5 kg — 450.000 so'm", knowledgeBase);
  assert.equal(invented.safe, false, "there is no 5 кг size -- transliteration must not become a blanket pass");
});

test("an Uzbek Cyrillic reply verifies against the same Russian knowledge base", () => {
  const knowledgeBase = "Фисташковая паста: 200 гр — 100.000, 1 кг — 450.000.";
  const result = checkForUnverifiedNumbers("Писта пастаси: 200 гр — 100.000 сўм, 1 кг — 450.000 сўм", knowledgeBase);

  assert.deepEqual(result.unverifiedNumbers, [], "Uzbek written in Cyrillic shares the knowledge base's own units");
  assert.equal(result.safe, true);
});
