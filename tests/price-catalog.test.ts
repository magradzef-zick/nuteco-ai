import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadKnowledgeBase, clearKnowledgeBaseCache } from "../src/knowledge/loader";
import { parsePriceCatalog, findMisattributedPrices, canonicalNumber } from "../src/engine/priceCatalog";
import { checkForUnverifiedNumbers } from "../src/engine/hallucinationGuardrail";

/**
 * These run against the real `knowledge/` directory on purpose. The whole
 * point of the price-catalog check is that it and the prompt read the same
 * client-maintained file -- a test with its own inline fixture catalogue
 * would keep passing while the real price list drifted into a shape the
 * parser no longer understands.
 */
function realKnowledgeBase(): string {
  clearKnowledgeBaseCache();
  return loadKnowledgeBase({ knowledgeDir: join(__dirname, "..", "knowledge"), forceReload: true });
}

const KB = realKnowledgeBase();
const CATALOG = parsePriceCatalog(KB);

test("the real price list parses into a catalogue", () => {
  assert.ok(CATALOG.entries.length >= 25, `expected the whole price list, got ${CATALOG.entries.length} rows`);

  const pistachioPaste = CATALOG.entries.find((entry) => entry.product === "Фисташковая паста");
  assert.ok(pistachioPaste, "Фисташковая паста missing from the parsed catalogue");
  assert.equal(pistachioPaste.pricesBySize.get(200), "100000");
  assert.equal(pistachioPaste.pricesBySize.get(500), "230000");
  assert.equal(pistachioPaste.pricesBySize.get(1000), "450000");
});

test("a size the price list marks with a dash is absent, not zero", () => {
  const peanutFlour = CATALOG.entries.find((entry) => entry.product === "Арахисовая мука");
  assert.ok(peanutFlour);
  assert.equal(peanutFlour.pricesBySize.has(150), false);
  assert.equal(peanutFlour.pricesBySize.get(500), "35000");
});

test("the odd sizes in the price list survive parsing", () => {
  const jerrys = CATALOG.entries.find((entry) => entry.product.startsWith("Jerry's Crunchy"));
  assert.ok(jerrys);
  assert.equal(jerrys.pricesBySize.get(300), "35000");

  const flakes = CATALOG.entries.find((entry) => entry.product === "Миндальные лепестки");
  assert.ok(flakes);
  assert.equal(flakes.pricesBySize.get(350), "75000");
  assert.equal(flakes.pricesBySize.get(1000), "220000");
});

test("prose tables elsewhere in the knowledge base are not read as price tables", () => {
  assert.equal(
    CATALOG.entries.some((entry) => /almond flour|bank transfer/i.test(entry.product)),
    false
  );
});

test("a correct price for a correct size passes", () => {
  const reply = "Фисташковая паста 1 кг — 450.000 сум.";
  assert.deepEqual(findMisattributedPrices(reply, ["450.000"], CATALOG), []);
  assert.equal(checkForUnverifiedNumbers(reply, KB).safe, true);
});

test("a whole correct price ladder passes", () => {
  const reply = "200 гр — 70.000\n500 гр — 130.000\n1 кг — 250.000\n\nЭто фундучная паста без мёда.";
  assert.equal(checkForUnverifiedNumbers(reply, KB).safe, true);
});

test("catches a real catalogue price attached to the wrong product", () => {
  // 250.000 is the hazelnut 1 kg price, not the pistachio one.
  const reply = "Фисташковая паста 1 кг — 250.000 сум.";
  const result = checkForUnverifiedNumbers(reply, KB);

  assert.equal(result.safe, false);
  assert.ok(result.unverifiedNumbers.includes("250.000"));
});

test("catches the right product's price quoted for the wrong size", () => {
  // 450.000 is the 1 kg price; the 500 g jar is 230.000.
  const reply = "Фисташковая паста 500 гр — 450.000 сум.";
  const result = checkForUnverifiedNumbers(reply, KB);

  assert.equal(result.safe, false);
  assert.ok(result.unverifiedNumbers.includes("450.000"));
});

test("catches a size the price list does not sell, even at a real price", () => {
  const reply = "Арахисовая мука 150 гр — 35.000 сум.";
  const result = checkForUnverifiedNumbers(reply, KB);

  assert.equal(result.safe, false);
});

test("catches an invented price written in the spreadsheet's bare format", () => {
  const reply = "Арахисовая паста с мёдом 200 гр — 26000 сум.";
  const result = checkForUnverifiedNumbers(reply, KB);

  assert.equal(result.safe, false);
  assert.ok(result.unverifiedNumbers.includes("26000"));
});

test("a correct price still verifies when the model reformats the separators", () => {
  for (const written of ["25.000", "25000", "25 000", "25 000"]) {
    const reply = `Арахисовая паста с мёдом 200 гр — ${written} сум.`;
    assert.equal(
      checkForUnverifiedNumbers(reply, KB).safe,
      true,
      `"${written}" should verify against the price list's 25.000`
    );
  }
});

test("a whole price ladder written on one line passes", () => {
  const reply = "Псиллиум 150 гр — 75.000, 500 гр — 225.000, 1 кг — 450.000";
  assert.equal(checkForUnverifiedNumbers(reply, KB).safe, true);
});

test("catches a swapped price inside a one-line ladder", () => {
  const reply = "Псиллиум 150 гр — 450.000, 500 гр — 225.000";
  const result = checkForUnverifiedNumbers(reply, KB);

  assert.equal(result.safe, false);
  assert.ok(result.unverifiedNumbers.includes("450.000"));
});

test("catches any price put on a product the price list deliberately leaves unpriced", () => {
  for (const reply of [
    "Соевый лецитин 1 кг — 90.000 сум.",
    "Миндальный марципан 500 гр — 80.000.",
    "Фундучное пралине 1 кг — 250.000 сум.",
  ]) {
    assert.equal(checkForUnverifiedNumbers(reply, KB).safe, false, `should not pass: ${reply}`);
  }
});

test("pistachio praline is priced and answers normally, unlike the other pralines", () => {
  assert.equal(checkForUnverifiedNumbers("Фисташковое пралине 1 кг — 450.000.", KB).safe, true);
});

test("tells apart product variants that differ by one word", () => {
  // 23.000 is the honey-free 200 g jar, 25.000 the one with honey. Both are
  // real catalogue prices, so only exact product matching separates them.
  const truthful = [
    "Арахисовая паста с мёдом 200 гр — 25.000.",
    "Арахисовая паста без мёда 200 гр — 23.000.",
    "Миндальная мука 500 гр — 80.000 сум.",
    "Миндальная мука кето 500 гр — 70.000 сум.",
  ];
  const swapped = [
    "Арахисовая паста с мёдом 200 гр — 23.000.",
    "Арахисовая паста без мёда 200 гр — 25.000.",
    "Миндальная мука 500 гр — 70.000 сум.",
    "Миндальная мука кето 500 гр — 80.000 сум.",
  ];

  for (const reply of truthful) {
    assert.equal(checkForUnverifiedNumbers(reply, KB).safe, true, `should pass: ${reply}`);
  }
  for (const reply of swapped) {
    assert.equal(checkForUnverifiedNumbers(reply, KB).safe, false, `should be caught: ${reply}`);
  }
});

test("a stem does not match a longer, different word", () => {
  // "Арахис дроблёный" must not be read into "арахисовая", or the crushed
  // peanut prices would vouch for the paste and flour lines.
  assert.equal(checkForUnverifiedNumbers("Арахис дроблёный 500 гр — 25.000.", KB).safe, true);
  assert.equal(checkForUnverifiedNumbers("Арахис дроблёный 500 гр — 23.000.", KB).safe, false);
  assert.equal(checkForUnverifiedNumbers("Арахисовая мука 500 гр — 25.000.", KB).safe, false);
});

test("prices pair to sizes by order, not by proximity, inside a one-line ladder", () => {
  const correct = "Псиллиум 150 гр — 75.000, 500 гр — 225.000, 1 кг — 450.000";
  assert.equal(checkForUnverifiedNumbers(correct, KB).safe, true);

  // Same three real prices, rotated onto the wrong sizes.
  const rotated = "Псиллиум 150 гр — 225.000, 500 гр — 75.000, 1 кг — 450.000";
  const result = checkForUnverifiedNumbers(rotated, KB);
  assert.equal(result.safe, false);
  assert.deepEqual(result.unverifiedNumbers.sort(), ["225.000", "75.000"]);
});

test("reads the price-then-size wording too", () => {
  assert.equal(checkForUnverifiedNumbers("Цена 230.000 за 500 гр, фисташковая паста.", KB).safe, true);
  assert.equal(checkForUnverifiedNumbers("Цена 250.000 за 500 гр, фисташковая паста.", KB).safe, false);
});

test("catches an invented price too small for the price-shaped number patterns", () => {
  const result = checkForUnverifiedNumbers("Семена чиа 150 гр — 800 сум.", KB);

  assert.equal(result.safe, false);
  assert.ok(result.unverifiedNumbers.includes("800"));
});

test("a bare price is not shredded into a stray fragment by the currency pattern", () => {
  const result = checkForUnverifiedNumbers("Миндальная мука 2 кг — 280000 сум.", KB);

  assert.equal(result.safe, false);
  assert.deepEqual(result.unverifiedNumbers, ["280000"]);
});

test("asking which variant the customer wants is not a price claim", () => {
  assert.equal(checkForUnverifiedNumbers("Арахисовая паста, а какую именно — с мёдом или без?", KB).safe, true);
});

test("an order quantity is not mistaken for a packing size", () => {
  const reply = "Миндальная мука 2 кг — 150.000 сум за кг.";
  assert.deepEqual(findMisattributedPrices(reply, ["150.000", "2 кг"], CATALOG), []);
});

test("abstains when the reply names no catalogue product", () => {
  const reply = "Доставка по Ташкенту обычно 25.000 сум.";
  assert.deepEqual(findMisattributedPrices(reply, ["25.000"], CATALOG), []);
});

test("canonicalNumber makes every written form of an amount comparable", () => {
  for (const written of ["25.000", "25 000", "25,000", "25000", "25 000"]) {
    assert.equal(canonicalNumber(written), "25000");
  }
});
