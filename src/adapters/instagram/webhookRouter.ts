import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger, type Logger } from "../../observability/logger";

/** How much of an unparseable request body to log -- enough to debug a malformed payload, not so much that logs balloon on a large/garbled body. Mirrors telegram/webhookRouter.ts. */
const PARSE_ERROR_BODY_PREVIEW_LENGTH = 200;

export interface InstagramWebhookHandlerOptions {
  /** The token you chose and entered into the Meta App Dashboard's webhook subscription form -- checked against the GET verification request's hub.verify_token. */
  verifyToken: string;
  /** Your Meta app's App Secret (App Dashboard -> Settings -> Basic). Used to verify the X-Hub-Signature-256 header on every POST delivery. Null/undefined means no check is performed -- strongly discouraged in production, the Instagram equivalent of telegram/webhookRouter.ts's secretToken tradeoff. */
  appSecret?: string | null;
  /**
   * Called once per parsed webhook POST body, which may contain multiple
   * messaging events -- see parseWebhookEvent.ts's doc comment on why
   * this differs from Telegram's one-event-per-call callback. Runs AFTER
   * the HTTP response has already been sent.
   */
  onEvent: (rawBody: unknown) => Promise<void>;
  logger?: Logger;
}

/**
 * Builds a Node http request handler for Instagram's (Meta Graph API)
 * messaging webhook. Framework-free, same rationale as
 * telegram/webhookRouter.ts. Unlike Telegram, this single route must
 * handle two HTTP methods:
 * - GET: Meta's one-time webhook verification handshake.
 * - POST: actual event deliveries.
 */
export function createInstagramWebhookHandler(
  options: InstagramWebhookHandlerOptions
): (req: IncomingMessage, res: ServerResponse) => void {
  const logger = options.logger ?? createLogger();

  return (req, res) => {
    if (req.method === "GET") {
      handleVerification(req, res, options.verifyToken, logger);
      return;
    }

    if (req.method !== "POST") {
      logger.warn("webhook.rejected_method", { method: req.method });
      res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed");
      return;
    }

    handleDelivery(req, res, options, logger);
  };
}

/**
 * Meta's webhook verification handshake: a GET request carrying
 * hub.mode=subscribe, hub.verify_token, and hub.challenge as query
 * parameters. Responding with hub.challenge's exact value (plain text)
 * confirms this endpoint is under our control; any mismatch must be
 * rejected, or anyone could point Meta's webhook subscription at a URL
 * they don't own.
 */
function handleVerification(req: IncomingMessage, res: ServerResponse, verifyToken: string, logger: Logger): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && challenge !== null && verifyTokenMatches(token, verifyToken)) {
    logger.info("instagram_webhook.verified", {});
    res.writeHead(200, { "content-type": "text/plain" }).end(challenge);
    return;
  }

  logger.warn("instagram_webhook.verification_failed", { mode });
  res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
}

function handleDelivery(
  req: IncomingMessage,
  res: ServerResponse,
  options: InstagramWebhookHandlerOptions,
  logger: Logger
): void {
  logger.info("webhook.received", { method: req.method });

  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("error", (error) => {
    logger.error("webhook.request_stream_error", { error: error.message });
  });

  req.on("end", () => {
    const rawBodyBuffer = Buffer.concat(chunks);

    if (options.appSecret && !signatureMatches(rawBodyBuffer, req.headers["x-hub-signature-256"], options.appSecret)) {
      logger.warn("webhook.rejected_unauthorized", {});
      res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
      return;
    }

    const rawBody = rawBodyBuffer.toString("utf-8");

    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch (error) {
      // Not Meta's fault if we can't parse it, but there's nothing useful
      // to retry here either -- acknowledge so Meta doesn't keep
      // resending a payload we'll never be able to parse.
      res.writeHead(200).end();
      logger.error("webhook.parse_error", {
        error: (error as Error).message,
        bodyPreview: rawBody.slice(0, PARSE_ERROR_BODY_PREVIEW_LENGTH),
      });
      return;
    }

    res.writeHead(200).end();

    options.onEvent(event).catch((error) => {
      logger.error("webhook.processing_error", { error: (error as Error).message });
    });
  });
}

/** Constant-time comparison for the verify token, mirroring telegram/webhookRouter.ts's secretTokenMatches -- see signatureMatches below for why this matters for a value meant to be secret-shaped. */
function verifyTokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Verifies Meta's X-Hub-Signature-256 header: an HMAC-SHA256 of the exact
 * raw request body bytes, keyed with the app secret, formatted as
 * "sha256=<hex>". Computed against the raw buffer (not the re-parsed/
 * re-serialized JSON), since re-serializing can produce different bytes
 * than what was actually signed (key order, whitespace differences).
 * Uses timingSafeEqual, mirroring telegram/webhookRouter.ts's
 * secretTokenMatches -- a naive string comparison would leak how many
 * leading characters matched via response timing.
 */
function signatureMatches(rawBody: Buffer, header: string | string[] | undefined, appSecret: string): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }

  const providedHex = header.slice("sha256=".length);
  const expectedHex = createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const providedBuffer = Buffer.from(providedHex, "hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
