/**
 * Whether it's currently within Nuteco's working hours -- Monday to
 * Friday, 10:00-18:00, Tashkent time (see knowledge/company.md). Client's
 * explicit rule: staff handle Telegram directly during these hours; the
 * AI agent takes over outside them. Instagram is unaffected by this --
 * it redirects to Telegram unconditionally, at all hours.
 *
 * Tashkent has used a fixed UTC+5 offset with no DST since 1992 -- no
 * timezone library needed, just a constant shift. If that ever changes,
 * this is the one place to update.
 */
const TASHKENT_UTC_OFFSET_HOURS = 5;

const OPENING_HOUR = 10;
const CLOSING_HOUR = 18;

/** 0 = Sunday, 6 = Saturday (JS Date convention) -- Monday(1) through Friday(5) are working days. */
function isWeekday(dayOfWeek: number): boolean {
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

/**
 * `now` is epoch milliseconds, not a `Date`, matching the same
 * `now: () => number` convention `ConversationEngine` already uses --
 * callers inject the current time rather than this function reading the
 * clock itself, so a specific moment (a Friday at 17:59, a Saturday at
 * noon) is trivial to test deterministically.
 */
export function isWithinWorkingHours(now: number): boolean {
  const tashkentTime = new Date(now + TASHKENT_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  // .getUTC*() on a shifted timestamp, not .get*() on the original --
  // .get*() reads the *host machine's* timezone, which has nothing to do
  // with Tashkent and would make this function's result depend on where
  // the process happens to be deployed.
  const dayOfWeek = tashkentTime.getUTCDay();
  const hour = tashkentTime.getUTCHours();

  return isWeekday(dayOfWeek) && hour >= OPENING_HOUR && hour < CLOSING_HOUR;
}
