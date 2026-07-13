import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStrongB2bSignal } from "../src/engine/b2bDetector";

test("detects explicit invoicing vocabulary", () => {
  assert.equal(detectStrongB2bSignal("Можно оплата по перечислению и счет-фактура?"), true);
});

test("detects an NDS/tax mention", () => {
  assert.equal(detectStrongB2bSignal("а с НДС сколько будет?"), true);
});

test("detects an explicit wholesale-pricing request", () => {
  assert.equal(detectStrongB2bSignal("у вас есть цены для бизнеса?"), true);
});

test("detects 'опт'/'wholesale' business intent", () => {
  assert.equal(detectStrongB2bSignal("нам нужно оптом 20 кг"), true);
});

test("detects a business-document request", () => {
  assert.equal(detectStrongB2bSignal("нужен договор и доверенность для нашей компании"), true);
});

test("detects English-language business vocabulary", () => {
  assert.equal(detectStrongB2bSignal("Can you send an invoice for a wholesale order?"), true);
});

test("does not flag an ordinary retail question", () => {
  assert.equal(detectStrongB2bSignal("Здравствуйте! Сколько стоит миндальная мука?"), false);
});

test("does not flag an ordinary retail order", () => {
  assert.equal(detectStrongB2bSignal("как обычно, 2 кг арахисовой пасты, оплата картой"), false);
});
