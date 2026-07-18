/**
 * Reads and validates the environment into a typed, fully-resolved config
 * object. Nothing else in the codebase should read `process.env` directly
 * -- this is the one place that happens, so every required value is
 * checked in one pass and failures are reported together, not one at a
 * time as the app happens to reach each usage.
 */
export interface InstagramConfig {
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
  pageId: string;
  graphApiVersion: string;
}

export interface AppConfig {
  telegramBotToken: string;
  /** Telegram's optional "X-Telegram-Bot-Api-Secret-Token" webhook header, if configured. Null means no check is performed -- see `securityWarnings()` below. */
  telegramWebhookSecretToken: string | null;
  managerNotificationChatId: string;
  /** Gemini API key -- see src/llm/gemini/GeminiProvider.ts. This is the only LLM provider wired up today; swapping providers means adding a new class behind src/llm/LlmProvider.ts and changing composition.ts, not changing this config shape. */
  geminiApiKey: string;
  geminiModel: string;
  knowledgeBaseDir: string;
  promptsDir: string;
  databasePath: string;
  port: number;
  /**
   * Present only when every INSTAGRAM_* variable is set -- null means
   * Instagram support is simply disabled, so an existing Telegram-only
   * deployment needs zero config changes. See parseInstagramConfig below
   * for the all-or-nothing validation rule.
   */
  instagram: InstagramConfig | null;
}

/**
 * Non-blocking security concerns worth surfacing loudly at startup, even
 * though they don't stop the app from running. Kept separate from
 * ConfigValidationError deliberately -- these are real risks, but not
 * "this literally cannot start" conditions, and conflating the two would
 * either make a genuinely optional setting mandatory or bury a real
 * warning inside noise the operator has to parse out.
 */
export function securityWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];

  if (!config.telegramWebhookSecretToken) {
    warnings.push(
      "TELEGRAM_WEBHOOK_SECRET_TOKEN is not set. Without it, anyone who discovers your webhook URL " +
        "can send fake Telegram updates to this server. Set it to a random string and configure the same " +
        "value when registering the webhook with Telegram (see src/scripts/registerWebhook.ts)."
    );
  }

  return warnings;
}

export class ConfigValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Configuration is invalid -- the application will not start until every item below is fixed.\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        `\n\nHow to fix: set the missing/invalid variable(s) in your .env file (see .env.example for the ` +
        `full list and format), then restart. If you're running via a process manager or container, make ` +
        `sure it's actually passing these variables through to the process.`
    );
    this.name = "ConfigValidationError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const telegramBotToken = requireNonEmptyString(
    env,
    "TELEGRAM_BOT_TOKEN",
    "needed to authenticate with Telegram's Bot API -- get one from @BotFather on Telegram",
    problems
  );
  const managerNotificationChatId = requireNonEmptyString(
    env,
    "MANAGER_NOTIFICATION_CHAT_ID",
    "needed so escalations have somewhere to be delivered -- the Telegram chat/group ID that should receive them",
    problems
  );
  const geminiApiKey = requireNonEmptyString(
    env,
    "GEMINI_API_KEY",
    "needed to generate real assistant replies -- get one from Google AI Studio",
    problems
  );
  const port = parsePort(env.PORT, problems);
  const instagram = parseInstagramConfig(env, problems);

  if (problems.length > 0) {
    throw new ConfigValidationError(problems);
  }

  return {
    telegramBotToken: telegramBotToken!,
    telegramWebhookSecretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim() || null,
    managerNotificationChatId: managerNotificationChatId!,
    geminiApiKey: geminiApiKey!,
    geminiModel: env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
    knowledgeBaseDir: env.KNOWLEDGE_BASE_DIR?.trim() || "./knowledge",
    promptsDir: env.PROMPTS_DIR?.trim() || "./prompts",
    databasePath: env.DATABASE_PATH?.trim() || "./data/nuteco.db",
    port: port!,
    instagram,
  };
}

/**
 * Instagram support is entirely optional -- an existing Telegram-only
 * deployment works unchanged with none of these set. But it's all-or-
 * nothing once any one of them is: a partially-configured Instagram setup
 * (most likely a typo'd variable name) is far more likely to be a mistake
 * than an intentional partial setup, so it fails loudly at startup
 * instead of silently running with Instagram half-disabled.
 */
function parseInstagramConfig(env: NodeJS.ProcessEnv, problems: string[]): InstagramConfig | null {
  const rawValues = {
    INSTAGRAM_PAGE_ACCESS_TOKEN: env.INSTAGRAM_PAGE_ACCESS_TOKEN?.trim(),
    INSTAGRAM_APP_SECRET: env.INSTAGRAM_APP_SECRET?.trim(),
    INSTAGRAM_VERIFY_TOKEN: env.INSTAGRAM_VERIFY_TOKEN?.trim(),
    INSTAGRAM_PAGE_ID: env.INSTAGRAM_PAGE_ID?.trim(),
  };

  const anySet = Object.values(rawValues).some((value) => !!value);
  if (!anySet) {
    return null;
  }

  const missing = Object.entries(rawValues).filter(([, value]) => !value);
  for (const [name] of missing) {
    problems.push(
      `${name} is required once any INSTAGRAM_* variable is set (Instagram support is all-or-nothing -- set ` +
        `every INSTAGRAM_* variable, or none of them to leave it disabled).`
    );
  }

  if (missing.length > 0) {
    return null;
  }

  return {
    pageAccessToken: rawValues.INSTAGRAM_PAGE_ACCESS_TOKEN!,
    appSecret: rawValues.INSTAGRAM_APP_SECRET!,
    verifyToken: rawValues.INSTAGRAM_VERIFY_TOKEN!,
    pageId: rawValues.INSTAGRAM_PAGE_ID!,
    graphApiVersion: env.INSTAGRAM_GRAPH_API_VERSION?.trim() || "v21.0",
  };
}

function requireNonEmptyString(
  env: NodeJS.ProcessEnv,
  name: string,
  why: string,
  problems: string[]
): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    problems.push(`${name} is required but not set (${why}).`);
    return undefined;
  }
  return value;
}

function parsePort(rawValue: string | undefined, problems: string[]): number | undefined {
  if (!rawValue || !rawValue.trim()) {
    return 3000; // a sensible default, not a required setting
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    problems.push(`PORT must be a whole number between 1 and 65535, got "${rawValue}".`);
    return undefined;
  }
  return parsed;
}
