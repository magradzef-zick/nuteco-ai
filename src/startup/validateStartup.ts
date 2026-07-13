import type { Database } from "better-sqlite3";
import type { TelegramTransport } from "../adapters/telegram/TelegramTransport";
import type { LlmProvider } from "../llm/LlmProvider";
import { createLogger, type Logger } from "../observability/logger";

/**
 * Everything that must be true before this process starts accepting real
 * traffic. Each check is independent and reports its own failure, so a
 * misconfigured deployment gets one clear list of what's wrong instead of
 * a confusing crash three requests in. This is intentionally separate
 * from config validation (config.ts): config validation checks that
 * *values are well-formed*; this checks that those values actually *work*
 * against the real systems they point to (a database connection that's
 * actually queryable, a Telegram token that's genuinely valid, a
 * knowledge base that has content).
 *
 * Fail-fast, no partial startup: `main()` (src/index.ts) builds all
 * dependencies first (which itself fails immediately if, say, the
 * database file can't be created at all), then runs every check here
 * before ever binding the HTTP port -- so a startup failure never leaves
 * the process half-listening for traffic it can't actually handle.
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
