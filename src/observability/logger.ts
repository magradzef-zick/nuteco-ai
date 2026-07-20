/**
 * Structured (JSON-lines) logging with automatic secret redaction. This is
 * the only place `console.log`/`console.error` should be called anywhere
 * in the codebase -- every other module accepts a `Logger` and calls that
 * instead, so redaction can never be accidentally skipped by writing
 * straight to the console somewhere.
 *
 * Two independent layers of redaction, deliberately overlapping:
 * 1. Field-name based: any field whose name looks like "token", "secret",
 *    "password", or "apikey" (case-insensitive) is replaced outright,
 *    regardless of its value.
 * 2. Pattern based: known secret shapes are scanned for and redacted
 *    wherever they appear in a fully-serialized log line -- including
 *    inside a URL or a nested error message/stack trace, which field-name
 *    redaction alone would miss. Covers Telegram bot tokens (embedded
 *    directly in every Telegram API request URL -- see
 *    HttpTelegramTransport.ts) and Google API keys (embedded directly in
 *    every Gemini API request URL -- see GeminiProvider.ts). Any future
 *    provider that puts a secret in a URL should add its shape here too.
 *
 *    Google API keys are matched two ways, deliberately redundant: a
 *    `key=` query-parameter pattern (position-based -- redacts whatever
 *    value Google puts there, regardless of its internal shape) and an
 *    `AIza`-prefix pattern (shape-based, for the common case, and for the
 *    rare event a key appears somewhere that isn't a `key=` parameter).
 *    The position-based pattern is the one that actually matters: it was
 *    added after a real key was seen that didn't start with `AIza` at
 *    all, which the shape-based pattern alone would have silently missed.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const SENSITIVE_KEY_PATTERN = /token|secret|password|apikey/i;
/** Telegram bot tokens, e.g. "123456789:AAExampleToken...". */
const TELEGRAM_BOT_TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;
/** Google API keys, e.g. "AIzaSyExampleKeyText1234567890abcdefg" (commonly 39 characters total, but matched as a minimum-length pattern -- deliberately tolerant, the same way the Telegram token pattern above is, rather than requiring an exact length that could quietly stop matching if the actual format is even slightly different than assumed). */
const GOOGLE_API_KEY_PATTERN = /AIza[A-Za-z0-9_-]{30,}/g;
/**
 * Any value passed as a credential-shaped query parameter -- `key=` (how
 * GeminiProvider.ts sends the API key) and `access_token=` (how
 * HttpInstagramTransport.ts sends the Page Access Token on every Graph API
 * request, including GET requests where it's the only place the token
 * appears at all), plus the other common names Meta/Google-style REST APIs
 * use for the same thing. Position-based rather than shape-based: does not
 * assume anything about what a given provider's credential looks like, so
 * it still catches one whose format changes or doesn't match a known
 * prefix pattern. `[^&\s"']+` stops at the next query-parameter separator,
 * or at whitespace/quote characters if the URL is embedded inside JSON/log
 * text rather than standing alone.
 */
const SENSITIVE_QUERY_PARAM_PATTERN = /([?&](?:key|access_token|token|secret|apikey|api_key)=)[^&\s"']+/gi;
const REDACTED_TOKEN_PLACEHOLDER = "[REDACTED_TOKEN]";

function redactString(value: string): string {
  return value
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, REDACTED_TOKEN_PLACEHOLDER)
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, `$1${REDACTED_TOKEN_PLACEHOLDER}`)
    .replace(GOOGLE_API_KEY_PATTERN, REDACTED_TOKEN_PLACEHOLDER);
}

function redactValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    return redactFields(value as LogFields);
  }
  return value;
}

function redactFields(fields: LogFields): LogFields {
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactValue(value);
  }
  return result;
}

function write(level: LogLevel, event: string, fields: LogFields): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redactFields(fields),
  };

  // The per-field redaction above handles the common cases. This second,
  // whole-line pass is the actual guarantee: even if a token ended up
  // somewhere the field-based pass didn't anticipate, it cannot survive
  // serialization to the final log line.
  const line = redactString(JSON.stringify(entry));

  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function createLogger(): Logger {
  return {
    debug: (event, fields = {}) => write("debug", event, fields),
    info: (event, fields = {}) => write("info", event, fields),
    warn: (event, fields = {}) => write("warn", event, fields),
    error: (event, fields = {}) => write("error", event, fields),
  };
}
