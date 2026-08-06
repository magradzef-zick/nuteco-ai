import { loadEnvIfPresent } from "../shared/loadEnvIfPresent";
import { loadConfig } from "../config/config";
import { HttpTelegramTransport } from "../adapters/telegram/HttpTelegramTransport";
import { createLogger } from "../observability/logger";

/**
 * A one-time deployment step, not something the running server calls on
 * every boot: tells Telegram where to deliver webhook updates for this
 * bot. Run this once after deploying (and again if the public URL ever
 * changes) via:
 *
 *   node --import tsx src/scripts/registerWebhook.ts https://your-domain.example/telegram/webhook
 *
 * Loads .env itself if one is present (see loadEnvIfPresent.ts) -- works
 * unchanged locally (where .env exists) and inside Docker (where it
 * doesn't; env vars are already injected via docker-compose).
 *
 * Requires HTTPS -- Telegram will not deliver webhooks to a plain http://
 * URL. If TELEGRAM_WEBHOOK_SECRET_TOKEN is set, it's registered alongside
 * the URL so Telegram includes it on every delivery (see
 * webhookRouter.ts's secret-token check).
 */

/**
 * Telegram Business (Secretary Mode) updates -- business_connection,
 * business_message, edited_business_message -- are opt-in, unlike
 * ordinary message updates: omitting `allowed_updates` gets everything
 * else by default, but never these. Explicitly listing every type this
 * project already handles (or deliberately no-ops, see
 * parseUpdate.ts's KNOWN_UNSUPPORTED_UPDATE_TYPES) alongside them, so
 * registering the webhook can't accidentally narrow what was already
 * being delivered.
 */
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "inline_query",
  "my_chat_member",
  "chat_member",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
];
async function main(): Promise<void> {
  loadEnvIfPresent();
  const logger = createLogger();
  const url = process.argv[2];

  if (!url) {
    console.error(
      "Usage: node --import tsx src/scripts/registerWebhook.ts <https://your-domain/telegram/webhook>"
    );
    process.exitCode = 1;
    return;
  }

  if (!url.startsWith("https://")) {
    console.error(`"${url}" must be an https:// URL -- Telegram will not deliver webhooks over plain http.`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const transport = new HttpTelegramTransport({ botToken: config.telegramBotToken, logger });

  await transport.setWebhook(url, config.telegramWebhookSecretToken ?? undefined, ALLOWED_UPDATES);

  logger.info("registerWebhook.success", { url });
  console.log(`Webhook registered: ${url}`);
}

main().catch((error) => {
  console.error("Failed to register webhook:", error);
  process.exitCode = 1;
});
