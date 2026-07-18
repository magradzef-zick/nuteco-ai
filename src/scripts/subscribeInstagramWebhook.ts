import { loadConfig } from "../config/config";
import { HttpInstagramTransport } from "../adapters/instagram/HttpInstagramTransport";
import { createLogger } from "../observability/logger";

/**
 * A one-time deployment step, not something the running server calls on
 * every boot: subscribes the configured Instagram-linked page to receive
 * "messages" webhook events.
 *
 * Unlike Telegram's registerWebhook.ts, this does NOT register the
 * webhook URL itself -- Meta requires the URL (and its verify-token
 * handshake) to be configured once in the Meta App Dashboard's Webhooks
 * product first. This script only performs the second, API-driven step:
 * telling Meta which fields to actually deliver for this specific page.
 *
 * Run once, after both the Dashboard webhook URL is set AND every
 * INSTAGRAM_* variable is configured in .env:
 *
 *   node --env-file=.env --import tsx src/scripts/subscribeInstagramWebhook.ts
 */
async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();

  if (!config.instagram) {
    console.error(
      "INSTAGRAM_* environment variables are not fully configured -- see .env.example. " +
        "Set every one of them, then re-run this script."
    );
    process.exitCode = 1;
    return;
  }

  const transport = new HttpInstagramTransport({
    pageAccessToken: config.instagram.pageAccessToken,
    pageId: config.instagram.pageId,
    graphApiVersion: config.instagram.graphApiVersion,
    logger,
  });

  await transport.subscribeWebhookFields(["messages"]);

  logger.info("subscribeInstagramWebhook.success", { pageId: config.instagram.pageId });
  console.log(`Subscribed page ${config.instagram.pageId} to Instagram "messages" webhook events.`);
}

main().catch((error) => {
  console.error("Failed to subscribe Instagram webhook:", error);
  process.exitCode = 1;
});
