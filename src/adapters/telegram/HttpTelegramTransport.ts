import {
  TelegramApiError,
  TelegramNetworkError,
  isRetryableApiError,
  type TelegramTransport,
} from "./TelegramTransport";
import { callWithRetry, type AttemptResult } from "../../shared/retry";
import { createLogger, type Logger } from "../../observability/logger";

/** Telegram's own response envelope: { ok: true, result } or { ok: false, error_code, description, parameters }. */
interface TelegramApiResponseBody {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface HttpTelegramTransportOptions {
  botToken: string;
  /** Injectable for tests -- defaults to the global fetch. Never mocked in production. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests -- defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  logger?: Logger;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The real, network-calling implementation of TelegramTransport, using
 * Telegram's plain HTTP Bot API (https://api.telegram.org/bot<token>/<method>)
 * and Node's built-in `fetch` -- no HTTP client library needed.
 */
export class HttpTelegramTransport implements TelegramTransport {
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly logger: Logger;

  constructor(options: HttpTelegramTransportOptions) {
    this.botToken = options.botToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.logger = options.logger ?? createLogger();
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.callApi("sendMessage", { chat_id: chatId, text });
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    await this.callApi("sendChatAction", { chat_id: chatId, action });
  }

  async getMe(): Promise<{ id: number; username: string | null }> {
    const result = (await this.callApi("getMe", {})) as { id: number; username?: string };
    return { id: result.id, username: result.username ?? null };
  }

  async setWebhook(url: string, secretToken?: string): Promise<void> {
    await this.callApi("setWebhook", {
      url,
      ...(secretToken ? { secret_token: secretToken } : {}),
    });
  }

  private async callApi(method: string, params: Record<string, unknown>): Promise<unknown> {
    return callWithRetry((attemptNumber) => this.attemptApiCall(method, params, attemptNumber), {
      maxAttempts: this.maxAttempts,
      baseDelayMs: this.baseDelayMs,
      sleep: this.sleep,
      onRetry: (attemptNumber, delayMs, error) => {
        // Never log `url` here or anywhere in this class -- it contains
        // the bot token. `method` (e.g. "sendMessage") is the Bot API
        // method name, not a URL, and is safe to log.
        this.logger.warn("telegram_api.retry", { method, attemptNumber, delayMs, error: error.message });
      },
    });
  }

  private async attemptApiCall(
    method: string,
    params: Record<string, unknown>,
    _attemptNumber: number
  ): Promise<AttemptResult<unknown>> {
    const url = `${this.baseUrl}/bot${this.botToken}/${method}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (cause) {
      const error = new TelegramNetworkError(
        `Network error calling Telegram method "${method}". This is usually a connectivity issue ` +
          `(no internet access, a firewall blocking api.telegram.org, or a DNS problem) rather than something ` +
          `wrong with the request itself -- it will be retried automatically.`,
        cause
      );
      this.logger.error("telegram_api.error", { method, retryable: true, error: error.message });
      return { outcome: "failure", failure: { error, retryable: true } };
    }

    const body = (await response.json()) as TelegramApiResponseBody;

    if (body.ok) {
      return { outcome: "success", result: body.result };
    }

    const statusCode = body.error_code ?? response.status;
    const error = new TelegramApiError(buildApiErrorMessage(method, statusCode, body.description), statusCode, body.parameters?.retry_after);
    const retryable = isRetryableApiError(error);

    this.logger.error("telegram_api.error", {
      method,
      statusCode,
      retryable,
      error: error.message,
    });

    return {
      outcome: "failure",
      failure: {
        error,
        retryable,
        retryAfterMs: error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : undefined,
      },
    };
  }
}

/** Builds an error message that explains what happened, and for the most common real-world cases, why and how to fix it -- not just Telegram's raw description. */
function buildApiErrorMessage(method: string, statusCode: number, description: string | undefined): string {
  const base = description ?? `Telegram API call "${method}" failed with status ${statusCode}.`;

  if (statusCode === 401 || statusCode === 403) {
    return (
      `${base} This usually means TELEGRAM_BOT_TOKEN is invalid, was revoked, or was copied incorrectly -- ` +
      `get a fresh token from @BotFather and update your .env file.`
    );
  }

  if (statusCode === 400 && method === "sendMessage") {
    return (
      `${base} For sendMessage, this is often an invalid chat_id (the customer may have blocked the bot, ` +
      `or the chat no longer exists) rather than a problem with this code.`
    );
  }

  return base;
}
