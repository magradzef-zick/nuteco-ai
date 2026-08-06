import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRequestedInput } from "../src/engine/requestedInputDetector";

test("detects a phone/contact request in Russian", () => {
  assert.deepEqual(detectRequestedInput("Подскажите, пожалуйста, ваш номер телефона"), {
    contact: true,
    location: false,
  });
});

test("detects a phone/contact request in Uzbek and English", () => {
  assert.equal(detectRequestedInput("Telefon raqamingizni yuboring").contact, true);
  assert.equal(detectRequestedInput("Could you share your phone number?").contact, true);
});

test("a location-only ask sets only the location flag", () => {
  assert.deepEqual(detectRequestedInput("Уточните, пожалуйста, адрес доставки"), {
    contact: false,
    location: true,
  });
});

test("detects a location request in Uzbek and English", () => {
  assert.equal(detectRequestedInput("Manzilingizni yuboring").location, true);
  assert.equal(detectRequestedInput("What's your delivery address?").location, true);
});

test("a message asking for both sets both flags -- Telegram shows both buttons", () => {
  assert.deepEqual(detectRequestedInput("Локацию и номер получателя, пожалуйста"), {
    contact: true,
    location: true,
  });
});

test("an ordinary reply with neither keyword sets neither flag", () => {
  assert.deepEqual(detectRequestedInput("Стоимость миндальной муки 150.000 сум за кг."), {
    contact: false,
    location: false,
  });
});
