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

  await transport.setWebhook(url, config.telegramWebhookSecretToken ?? undefined);

  logger.info("registerWebhook.success", { url });
  console.log(`Webhook registered: ${url}`);
}

main().catch((error) => {
  console.error("Failed to register webhook:", error);
  process.exitCode = 1;
});
