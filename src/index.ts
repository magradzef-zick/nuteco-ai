import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { loadEnvIfPresent } from "./shared/loadEnvIfPresent";
import { loadConfig, securityWarnings, ConfigValidationError } from "./config/config";
import { buildDependencies, handleIncomingTelegramUpdate, handleIncomingInstagramUpdate } from "./composition";
import { createTelegramWebhookHandler } from "./adapters/telegram/webhookRouter";
import { createInstagramWebhookHandler } from "./adapters/instagram/webhookRouter";
import { loadKnowledgeBase } from "./knowledge/loader";
import { loadSystemPrompt } from "./prompts/loader";
import {
  runStartupChecks,
  schedulePeriodicHealthCheck,
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
/** Deliberately cheap -- confirms the HTTP server itself is accepting connections, not that every downstream dependency (DB, Telegram, Gemini, Instagram) is still reachable right now. Startup validation already gates all of that before the process ever starts listening; re-checking it on every health probe would make the healthcheck itself a source of false negatives during a transient third-party hiccup. Intended for Docker's HEALTHCHECK / a load balancer probe. */
const HEALTH_CHECK_PATH = "/health";
/**
 * The customer-facing privacy policy (`public/privacy.html`). Served by
 * this process rather than by nginx because nginx already proxies this
 * whole domain here, so a location block would be a second place to keep
 * in sync for no gain -- and because Meta requires a reachable privacy
 * policy URL before an app can be published at all, which makes this page
 * a deployment dependency, not a nice-to-have. Read from disk per request:
 * it is one small file served a handful of times a month, and reading it
 * live means correcting the text needs no redeploy, matching how
 * knowledge/ and prompts/ already work.
 */
const PRIVACY_POLICY_PATH = "/privacy";
/** Resolved from the working directory, the same convention `KNOWLEDGE_BASE_DIR`/`PROMPTS_DIR` already use -- this process is always started from the project root. */
const PRIVACY_POLICY_FILE = "./public/privacy.html";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The full route table, as a standalone function so it's unit-testable
 * without booting the whole process (real config, real DB, real network
 * calls to Telegram/Gemini/Instagram) the way `main()` below does. `main()`
 * is just this function wired up with the real handlers.
 */
export function createRequestHandler(options: {
  telegramWebhookHandler: RequestHandler;
  instagramWebhookHandler: RequestHandler | null;
}): RequestHandler {
  return (req, res) => {
    const pathname = new URL(req.url ?? "", "http://localhost").pathname;

    if (pathname === HEALTH_CHECK_PATH) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname === PRIVACY_POLICY_PATH) {
      let html: string;
      try {
        html = readFileSync(PRIVACY_POLICY_FILE, "utf-8");
      } catch {
        // Missing file is a deployment problem, not a request problem --
        // answer honestly rather than serving an empty page that would
        // still pass Meta's reachability check while telling a customer
        // nothing.
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Privacy policy is temporarily unavailable.");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }

    if (pathname === TELEGRAM_WEBHOOK_PATH) {
      options.telegramWebhookHandler(req, res);
      return;
    }

    if (options.instagramWebhookHandler && pathname === INSTAGRAM_WEBHOOK_PATH) {
      options.instagramWebhookHandler(req, res);
      return;
    }

    res.writeHead(404).end();
  };
}

/**
 * The real process entrypoint. This is the one file in the whole project
 * that genuinely cannot run without real credentials -- every other module
 * is built and tested against fakes. Running this file is where a real
 * TELEGRAM_BOT_TOKEN and a real GEMINI_API_KEY both become necessary, at
 * the `telegramTokenCheck` / `llmProviderCheck` steps below.
 *
 * Loads .env itself if one is present (see loadEnvIfPresent.ts) -- the
 * same entrypoint command works unchanged locally (where .env exists) and
 * inside Docker (where it doesn't; env vars are already injected via
 * docker-compose's env_file).
 */
async function main(): Promise<void> {
  loadEnvIfPresent();
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

  const server = createServer(createRequestHandler({ telegramWebhookHandler, instagramWebhookHandler }));

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

  if (config.tokenHealthCheckIntervalMs > 0) {
    schedulePeriodicHealthCheck(startupChecks, config.tokenHealthCheckIntervalMs, logger);
  }
}

// Only run as a side effect when this file is the actual process entrypoint
// (`node ... src/index.ts`) -- not when it's imported elsewhere, e.g. tests
// importing `createRequestHandler` above. Without this guard, importing this
// module for its exports would also boot the real app (real config, real
// network calls) as an unwanted side effect.
if (require.main === module) {
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
}
