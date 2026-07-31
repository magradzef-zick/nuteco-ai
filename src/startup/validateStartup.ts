import type { Database } from "better-sqlite3";
import type { TelegramTransport } from "../adapters/telegram/TelegramTransport";
import type { InstagramTransport } from "../adapters/instagram/InstagramTransport";
import type { LlmProvider } from "../llm/LlmProvider";
import { createLogger, type Logger } from "../observability/logger";

/**
 * What must be true before the process takes real traffic. Checks are
 * independent so a misconfigured deployment gets one clear list instead of
 * a crash three requests in.
 *
 * Separate from config.ts on purpose: that checks values are well-formed,
 * this checks they actually work against the systems they point at.
 *
 * Runs before the HTTP port is bound, so a failure never leaves the
 * process half-listening.
 */

export interface StartupCheck {
  name: string;
  run: () => Promise<void>;
}

export class StartupValidationError extends Error {
  constructor(public readonly failures: { name: string; error: Error }[]) {
    super(
      `${failures.length} startup check(s) failed -- the application will not start:\n` +
        failures.map((f) => `  - ${f.name}: ${f.error.message}`).join("\n")
    );
    this.name = "StartupValidationError";
  }
}

/**
 * Runs every check, collecting all failures rather than stopping at the
 * first one -- the same "report everything at once" principle as config
 * validation. Logs each check's outcome individually (so a future
 * developer can see, from logs alone, exactly which checks ran and which
 * of them failed, not just the aggregate) before throwing
 * StartupValidationError if anything failed.
 */
export async function runStartupChecks(checks: StartupCheck[], logger: Logger = createLogger()): Promise<void> {
  const failures: { name: string; error: Error }[] = [];

  for (const check of checks) {
    try {
      await check.run();
      logger.info("startup.check_passed", { check: check.name });
    } catch (error) {
      logger.error("startup.check_failed", { check: check.name, error: (error as Error).message });
      failures.push({ name: check.name, error: error as Error });
    }
  }

  if (failures.length > 0) {
    throw new StartupValidationError(failures);
  }
}

/**
 * Re-runs the same startup checks on a fixed interval for as long as the
 * process is running, so a token that was valid at startup but later
 * expires/gets revoked (Telegram, Instagram, or Gemini) shows up in the
 * logs on its own, instead of only being discovered the next time a real
 * customer message happens to fail. Deliberately never throws or crashes
 * the process on failure -- a periodic health signal that could itself
 * take the app down would be worse than not having it; the point is
 * visibility (an operator watching logs/alerts), not enforcement.
 *
 * `.unref()` so this timer never keeps the process alive on its own --
 * graceful shutdown (src/lifecycle/shutdown.ts) does not need to know
 * about it.
 */
export function schedulePeriodicHealthCheck(
  checks: StartupCheck[],
  intervalMs: number,
  logger: Logger
): NodeJS.Timeout {
  const timer = setInterval(() => {
    runStartupChecks(checks, logger).catch((error) => {
      logger.error("token_health_check.failed", { error: (error as Error).message });
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

/** Confirms the configured knowledge base actually loads and isn't empty. */
export function knowledgeBaseCheck(loadKnowledgeBaseFn: () => string): StartupCheck {
  return {
    name: "knowledge base loads",
    run: async () => {
      const text = loadKnowledgeBaseFn();
      if (!text || text.trim().length === 0) {
        throw new Error(
          "the knowledge base loaded but is empty. Confirm KNOWLEDGE_BASE_DIR points at a directory " +
            "containing the knowledge/*.md files."
        );
      }
    },
  };
}

/** Confirms the configured system prompt (prompts/system_prompt.md) actually loads and isn't empty -- same reasoning as knowledgeBaseCheck. */
export function systemPromptCheck(loadSystemPromptFn: () => string): StartupCheck {
  return {
    name: "system prompt loads",
    run: async () => {
      const text = loadSystemPromptFn();
      if (!text || text.trim().length === 0) {
        throw new Error(
          "the system prompt loaded but is empty. Confirm PROMPTS_DIR points at a directory containing " +
            "prompts/system_prompt.md."
        );
      }
    },
  };
}

/**
 * Confirms the already-open database connection is actually usable, by
 * running a trivial query against it -- deliberately does NOT re-open the
 * database file (buildDependencies() already did that, and already fails
 * fast if the file itself can't be opened/created; re-opening here would
 * just create a redundant second connection to the same file).
 */
export function databaseCheck(db: Database): StartupCheck {
  return {
    name: "database is queryable",
    run: async () => {
      try {
        db.prepare("SELECT 1").get();
      } catch (cause) {
        throw new Error(
          `the database connection at "${db.name}" did not respond to a simple query. The file may be ` +
            `corrupted, or DATABASE_PATH may point somewhere this process can't actually read/write.`,
          { cause }
        );
      }
    },
  };
}

/**
 * Confirms the Telegram bot token is genuinely valid by asking Telegram
 * who the bot is (getMe), rather than only checking that a token-shaped
 * string is present. An invalid token should fail loudly here, at
 * startup, not silently on the first customer message.
 */
export function telegramTokenCheck(transport: TelegramTransport): StartupCheck {
  return {
    name: "Telegram bot token is valid",
    run: async () => {
      try {
        await transport.getMe();
      } catch (cause) {
        throw new Error(
          "Telegram rejected this bot token. Check TELEGRAM_BOT_TOKEN in your .env file was copied " +
            "correctly from @BotFather, and that the bot hasn't been deleted or had its token regenerated.",
          { cause }
        );
      }
    },
  };
}

/**
 * Confirms the Instagram page access token is genuinely valid by asking
 * the Graph API who the connected account is -- same reasoning as
 * telegramTokenCheck. Only added to the startup check list when Instagram
 * is configured -- see src/index.ts.
 */
export function instagramTokenCheck(transport: InstagramTransport): StartupCheck {
  return {
    name: "Instagram page access token is valid",
    run: async () => {
      try {
        await transport.getProfile();
      } catch (cause) {
        throw new Error(
          "The Instagram Graph API rejected this page access token. Check INSTAGRAM_PAGE_ACCESS_TOKEN in your " +
            ".env file is valid and hasn't expired, and that INSTAGRAM_PAGE_ID matches the same account.",
          { cause }
        );
      }
    },
  };
}

/**
 * Confirms the configured LLM provider is genuinely reachable and the API
 * key is valid, via LlmProvider.checkHealth() -- written against the
 * generic interface, not against Gemini specifically, so this check keeps
 * working unchanged if the provider is ever swapped.
 */
export function llmProviderCheck(provider: LlmProvider): StartupCheck {
  return {
    name: "LLM provider is reachable",
    run: async () => {
      try {
        await provider.checkHealth();
      } catch (cause) {
        throw new Error(
          "The configured LLM provider rejected the health check. Check GEMINI_API_KEY in your .env file " +
            "is valid and GEMINI_MODEL names a model your key actually has access to.",
          { cause }
        );
      }
    },
  };
}
