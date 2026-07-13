import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createLogger, type Logger } from "../../observability/logger";

/** How much of an unparseable request body to log -- enough to debug a malformed payload, not so much that logs balloon on a large/garbled body. */
const PARSE_ERROR_BODY_PREVIEW_LENGTH = 200;

export interface TelegramWebhookHandlerOptions {
  /** Telegram's "X-Telegram-Bot-Api-Secret-Token" header value to require, if configured. Null/undefined means no check is performed (see config.ts's securityWarnings for why that's discouraged in production). */
  secretToken?: string | null;
  /** Called once per valid, parsed update. Runs AFTER the HTTP response has already been sent -- see the acknowledge-then-process note below. */
  onUpdate: (update: unknown) => Promise<void>;
  logger?: Logger;
}

/**
 * Builds a Node http request handler for Telegram's webhook. Framework-free
 * on purpose -- this project has exactly one route with one method, which
 * doesn't justify adding a routing library as a dependency.
 *
 * Acknowledges the request (HTTP 200) as soon as the body is read and
 * parsed, THEN calls `onUpdate` -- rather than waiting for `onUpdate` to
 * finish before responding. This is deliberate: a slow synchronous
 * response risks Telegram retrying delivery of the same update, which
 * would otherwise cause the same message to be processed twice. The
 * MessageDebouncer is what makes that eventual duplicate delivery safe
 * once it arrives.
 */
export function createTelegramWebhookHandler(
  options: TelegramWebhookHandlerOptions
): (req: IncomingMessage, res: ServerResponse) => void {
  const logger = options.logger ?? createLogger();

  return (req, res) => {
    logger.info("webhook.received", { method: req.method });

    if (req.method !== "POST") {
      logger.warn("webhook.rejected_method", { method: req.method });
      res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed");
      return;
    }

    if (options.secretToken && !secretTokenMatches(req.headers["x-telegram-bot-api-secret-token"], options.secretToken)) {
      logger.warn("webhook.rejected_unauthorized", {});
      res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
      return;
    }

    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("error", (error) => {
      logger.error("webhook.request_stream_error", { error: error.message });
    });

    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf-8");

      let update: unknown;
      try {
        update = JSON.parse(rawBody);
      } catch (error) {
        // Not Telegram's fault if we can't parse it, but there's nothing
        // useful to retry here either -- acknowledge so Telegram doesn't
        // keep resending a payload we'll never be able to parse.
        res.writeHead(200).end();
        logger.error("webhook.parse_error", {
          error: (error as Error).message,
          bodyPreview: rawBody.slice(0, PARSE_ERROR_BODY_PREVIEW_LENGTH),
        });
        return;
      }

      res.writeHead(200).end();

      options.onUpdate(update).catch((error) => {
        logger.error("webhook.processing_error", { error: (error as Error).message });
      });
    });
  };
}

/**
 * Constant-time comparison for the webhook secret token, using Node's
 * `timingSafeEqual` -- a naive `===` comparison leaks how many leading
 * characters matched via response timing, which matters for a value
 * that's meant to be a real secret (see the security review this was
 * written for).
 */
function secretTokenMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, so unequal-length inputs must be rejected before calling it.
  // This still leaks the *length* via timing, which is an accepted,
  // standard tradeoff for this kind of check -- the content is what
  // needs to be non-guessable one character at a time, not the length.
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
