import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinWorkingHours } from "../src/engine/businessHours";

/** All fixtures given as the equivalent UTC instant, converted by hand (Tashkent = UTC+5, no DST) and cross-checked against a known day-of-week (2026-08-03 is a Monday, 2026-08-04 is a Tuesday -- see the session's own date). */
function tashkent(isoUtc: string): number {
  return new Date(isoUtc).getTime();
}

test("10:00 Tashkent, a Monday, is within working hours -- opening boundary is inclusive", () => {
  assert.equal(isWithinWorkingHours(tashkent("2026-08-03T05:00:00Z")), true);
});

test("09:59:59 Tashkent, a Monday, is not yet within working hours", () => {
  assert.equal(isWithinWorkingHours(tashkent("2026-08-03T04:59:59Z")), false);
});

test("17:59:59 Tashkent, a Monday, is still within working hours", () => {
  assert.equal(isWithinWorkingHours(tashkent("2026-08-03T12:59:59Z")), true);
});

test("18:00:00 Tashkent, a Monday, is no longer within working hours -- closing boundary is exclusive", () => {
  assert.equal(isWithinWorkingHours(tashkent("2026-08-03T13:00:00Z")), false);
});

test("noon on a Saturday is outside working hours regardless of time of day", () => {
  assert.equal(isWithinWorkingHours(tashkent("2026-08-08T07:00:00Z")), false);
});

test("noon on a Sunday is outside working hours regardless of time of day", () => {
  assert.equal(isWithinWorkingHours(tashkent("2026-08-09T07:00:00Z")), false);
});

test("17:59:59 on a Friday is still within working hours -- Friday is a working day", () => {
  assert.equal(isWithinWorkingHours(tashkent("2026-08-07T12:59:59Z")), true);
});

test("the check uses Tashkent's offset, not the host machine's timezone", () => {
  // 04:00 UTC is 09:00 Tashkent (before opening) but would be a completely
  // different, ambiguous local hour on a host machine set to any other
  // timezone -- this only passes if the function shifts by a fixed +5h
  // and reads UTC getters on the result, never the host's local getters.
  assert.equal(isWithinWorkingHours(tashkent("2026-08-03T04:00:00Z")), false);
  assert.equal(isWithinWorkingHours(tashkent("2026-08-03T05:00:01Z")), true);
});
