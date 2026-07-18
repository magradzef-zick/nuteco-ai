import { createServer } from "node:http";
import { loadConfig, securityWarnings, ConfigValidationError } from "./config/config";
import { buildDependencies, handleIncomingTelegramUpdate, handleIncomingInstagramUpdate } from "./composition";
import { createTelegramWebhookHandler } from "./adapters/telegram/webhookRouter";
import { createInstagramWebhookHandler } from "./adapters/instagram/webhookRouter";
import { loadKnowledgeBase } from "./knowledge/loader";
import { loadSystemPrompt } from "./prompts/loader";
import {
  runStartupChecks,
  knowledgeBaseCheck,
  systemPromptCheck,
  databaseCheck,
  telegramTokenCheck,
  instagramTokenCheck,
  llmProviderCheck,
  StartupValidationError,
  type StartupCheck,
} from "./startup/validateStartup";
import { createShutdownHandler } from "./lifecycle/shutdown";
import { createLogger } from "./observability/logger";

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
const INSTAGRAM_WEBHOOK_PATH = "/instagram/webhook";

/**
 * The real process entrypoint. This is the one file in the whole project
 * that genuinely cannot run without real credentials -- every other module
 * is built and tested against fakes. Running this file is where a real
 * TELEGRAM_BOT_TOKEN and a real GEMINI_API_KEY both become necessary, at
 * the `telegramTokenCheck` / `llmProviderCheck` steps below.
 */
async function main(): Promise<void> {
  const logger = createLogger();
  logger.info("startup.begin", {});

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      logger.error("config.error", { problems: error.problems });
    }
    throw error;
  }

  for (const warning of securityWarnings(config)) {
    logger.warn("startup.security_warning", { warning });
  }

  const deps = buildDependencies(config, logger);

  const startupChecks: StartupCheck[] = [
    knowledgeBaseCheck(() => loadKnowledgeBase({ knowledgeDir: config.knowledgeBaseDir })),
    systemPromptCheck(() => loadSystemPrompt(config.promptsDir)),
    databaseCheck(deps.db),
    telegramTokenCheck(deps.transport),
    llmProviderCheck(deps.llmProvider),
  ];
  if (deps.instagramTransport) {
    startupChecks.push(instagramTokenCheck(deps.instagramTransport));
  }

  try {
    await runStartupChecks(startupChecks, logger);
  } catch (error) {
    // Individual failures were already logged (startup.check_failed) inside
    // runStartupChecks -- this is the single "startup did not succeed"
    // event for anyone only watching for that.
    logger.error("startup.failed", { error: (error as Error).message });
    deps.close();
    throw error;
  }

  const telegramWebhookHandler = createTelegramWebhookHandler({
    secretToken: config.telegramWebhookSecretToken,
    onUpdate: (update) => handleIncomingTelegramUpdate(update, deps),
    logger,
  });

  // Present only when INSTAGRAM_* config is set (see config.ts) -- an
  // existing Telegram-only deployment gets exactly the same server as
  // before, with no second route ever registered.
  const instagramWebhookHandler = config.instagram
    ? createInstagramWebhookHandler({
        verifyToken: config.instagram.verifyToken,
        appSecret: config.instagram.appSecret,
        onEvent: (event) => handleIncomingInstagramUpdate(event, deps),
        logger,
      })
    : null;

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;

    if (pathname === TELEGRAM_WEBHOOK_PATH) {
      telegramWebhookHandler(req, res);
      return;
    }

    if (instagramWebhookHandler && pathname === INSTAGRAM_WEBHOOK_PATH) {
      instagramWebhookHandler(req, res);
      return;
    }

    res.writeHead(404).end();
  });

  const shutdown = createShutdownHandler({
    server,
    closeResources: deps.close,
    logger,
    exit: (code) => process.exit(code),
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  server.listen(config.port, () => {
    logger.info("startup.success", { port: config.port, instagramEnabled: config.instagram !== null });
  });
}

main().catch((error) => {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else if (error instanceof StartupValidationError) {
    console.error(error.message);
  } else {
    console.error("Failed to start:", error);
  }
  process.exitCode = 1;
});
