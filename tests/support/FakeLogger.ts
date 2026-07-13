import type { Logger, LogFields } from "../../src/observability/logger";

export interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: LogFields;
}

/** A Logger that records every call instead of writing to the console -- shared by any test that wants to assert on what was logged. */
export function fakeLogger(): { logger: Logger; entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const record = (level: RecordedLog["level"]) => (event: string, fields: LogFields = {}) =>
    void entries.push({ level, event, fields });

  return {
    entries,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
  };
}
