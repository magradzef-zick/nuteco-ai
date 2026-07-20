import {
  InstagramApiError,
  InstagramNetworkError,
  isRetryableApiError,
  type InstagramTransport,
} from "./InstagramTransport";
import { callWithRetry, type AttemptResult } from "../../shared/retry";
import { createLogger, type Logger } from "../../observability/logger";

/** The Graph API's own error envelope shape: { error: { message, type, code, ... } }, present on non-2xx responses. */
interface GraphApiErrorBody {
  error?: { message?: string; type?: string; code?: number };
}

export interface HttpInstagramTransportOptions {
  pageAccessToken: string;
  /** The Instagram-linked Page ID this transport manages -- only needed for subscribeWebhookFields. */
  pageId: string;
  /** Injectable for tests -- defaults to the global fetch. Never mocked in production. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests -- defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  graphApiVersion?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  logger?: Logger;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_GRAPH_API_VERSION = "v21.0";

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The real, network-calling implementation of InstagramTransport, using
 * Meta's Graph API (https://graph.facebook.com/<version>/<path>) and
 * Node's built-in `fetch` -- no HTTP client library needed, mirroring
 * HttpTelegramTransport.ts's structure exactly.
 *
 * Unlike Telegram (which puts the retry_after for a 429 in the response
 * body), the Graph API does not reliably provide a machine-readable
 * retry delay -- so, unlike HttpTelegramTransport, failures here always
 * fall back to computed exponential backoff rather than ever honoring a
 * server-provided delay.
 */
export class HttpInstagramTransport implements InstagramTransport {
  private readonly pageAccessToken: string;
  private readonly pageId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly graphApiVersion: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly logger: Logger;

  constructor(options: HttpInstagramTransportOptions) {
    this.pageAccessToken = options.pageAccessToken;
    this.pageId = options.pageId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.baseUrl = options.baseUrl ?? "https://graph.facebook.com";
    this.graphApiVersion = options.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.logger = options.logger ?? createLogger();
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    await this.callApi("POST", "me/messages", { recipient: { id: recipientId }, message: { text } });
  }

  async sendSenderAction(recipientId: string, action: "typing_on" | "typing_off"): Promise<void> {
    await this.callApi("POST", "me/messages", { recipient: { id: recipientId }, sender_action: action });
  }

  async getProfile(): Promise<{ id: string; username: string | null }> {
    const result = (await this.callApi("GET", "me", undefined, { fields: "id,username" })) as {
      id: string;
      username?: string;
    };
    return { id: result.id, username: result.username ?? null };
  }

  async subscribeWebhookFields(fields: string[]): Promise<void> {
    await this.callApi("POST", `${this.pageId}/subscribed_apps`, undefined, { subscribed_fields: fields.join(",") });
  }

  private async callApi(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    extraQueryParams?: Record<string, string>
  ): Promise<unknown> {
    return callWithRetry(() => this.attemptApiCall(method, path, body, extraQueryParams), {
      maxAttempts: this.maxAttempts,
      baseDelayMs: this.baseDelayMs,
      sleep: this.sleep,
      onRetry: (attemptNumber, delayMs, error) => {
        // Never log the built URL here or anywhere in this class -- it
        // carries the page access token as a query parameter. `path`
        // (e.g. "me/messages") is safe to log.
        this.logger.warn("instagram_api.retry", { path, attemptNumber, delayMs, error: error.message });
      },
    });
  }

  private async attemptApiCall(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    extraQueryParams: Record<string, string> | undefined
  ): Promise<AttemptResult<unknown>> {
    const url = new URL(`${this.baseUrl}/${this.graphApiVersion}/${path}`);
    url.searchParams.set("access_token", this.pageAccessToken);
    for (const [key, value] of Object.entries(extraQueryParams ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        url.toString(),
        body
          ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : { method }
      );
    } catch (cause) {
      const error = new InstagramNetworkError(
        `Network error calling Instagram Graph API path "${path}". This is usually a connectivity issue ` +
          `(no internet access, a firewall blocking graph.facebook.com, or a DNS problem) rather than something ` +
          `wrong with the request itself -- it will be retried automatically.`,
        cause
      );
      this.logger.error("instagram_api.error", { path, retryable: true, error: error.message });
      return { outcome: "failure", failure: { error, retryable: true } };
    }

    const responseBody = (await response.json().catch(() => ({}))) as GraphApiErrorBody & Record<string, unknown>;

    if (response.ok) {
      return { outcome: "success", result: responseBody };
    }

    const statusCode = response.status;
    const error = new InstagramApiError(buildApiErrorMessage(path, statusCode, responseBody.error?.message), statusCode);
    const retryable = isRetryableApiError(error);

    this.logger.error("instagram_api.error", { path, statusCode, retryable, error: error.message });

    return { outcome: "failure", failure: { error, retryable } };
  }
}

/** Builds an error message that explains what happened, and for the most common real-world cases, why and how to fix it -- not just the Graph API's raw description. Mirrors HttpTelegramTransport.ts's buildApiErrorMessage. */
function buildApiErrorMessage(path: string, statusCode: number, description: string | undefined): string {
  const base = description ?? `Instagram Graph API call "${path}" failed with status ${statusCode}.`;

  if ((statusCode === 401 || statusCode === 403) && /permission/i.test(base)) {
    return (
      `${base} This is a missing OAuth scope on INSTAGRAM_PAGE_ACCESS_TOKEN, not an invalid/expired token -- ` +
      `the token needs to be regenerated with the missing permission included in the consent scope, then ` +
      `re-derived via GET /me/accounts (see docs/README for the token acquisition flow).`
    );
  }

  if (statusCode === 401 || statusCode === 403) {
    return (
      `${base} This usually means INSTAGRAM_PAGE_ACCESS_TOKEN is invalid, expired, or was copied incorrectly -- ` +
      `generate a fresh token in the Meta App Dashboard and update your .env file.`
    );
  }

  if (statusCode === 400 && path === "me/messages") {
    return (
      `${base} For sending a message, this is often an expired messaging window or an invalid recipient id ` +
      `(the conversation may no longer be open) rather than a problem with this code.`
    );
  }

  return base;
}
