import { callWithRetry, type AttemptResult } from "../../shared/retry";
import { createLogger, type Logger } from "../../observability/logger";
import type { LlmProvider, LlmReplyRequest, LlmReplyResult } from "../LlmProvider";

/**
 * Gemini's error envelope on a non-2xx response: { error: { code, message, status } }.
 */
interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

interface GeminiGenerateContentBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiApiError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "GeminiApiError";
  }
}

export class GeminiNetworkError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = "GeminiNetworkError";
  }
}

function isRetryableGeminiError(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  /** Injectable for tests -- defaults to the global fetch. Never mocked in production. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests -- defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  logger?: Logger;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_TEMPERATURE = 0.4;
/**
 * Generous relative to this project's actual replies (the longest real
 * reply seen in live testing -- a full multi-product price list -- used
 * ~120 output tokens), because thinking is disabled below and no longer
 * shares this budget. This is headroom for a genuinely long reply (e.g.
 * a multi-item order summary), not a number tuned to the common case.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
/** Gemini's `finishReason` value when generation stopped because maxOutputTokens was reached, rather than the model finishing naturally. */
const FINISH_REASON_MAX_TOKENS = "MAX_TOKENS";

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The real, network-calling implementation of LlmProvider, using Gemini's
 * plain HTTP REST API and Node's built-in `fetch` -- no SDK dependency,
 * same philosophy as HttpTelegramTransport.ts. Reuses the exact same
 * retry/backoff module (src/shared/retry.ts) rather than re-implementing
 * retry logic a second time.
 *
 * Security note, mirroring HttpTelegramTransport.ts's own lesson: Gemini's
 * API key is passed as a URL query parameter, so it is embedded directly
 * in every request URL. This class only ever logs the method name (e.g.
 * "generateContent"), never the URL -- and the shared logger additionally
 * scrubs Google API-key-shaped strings from every log line as a second,
 * independent layer (see src/observability/logger.ts).
 */
export class GeminiProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;
  private readonly logger: Logger;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.logger = options.logger ?? createLogger();
  }

  async generateReply(request: LlmReplyRequest): Promise<LlmReplyResult> {
    const body = {
      system_instruction: { parts: [{ text: request.systemPrompt }] },
      contents: [
        ...request.historyTurns.map((turn) => ({
          role: turn.role === "assistant" ? "model" : "user",
          parts: [{ text: turn.text }],
        })),
        { role: "user", parts: [{ text: request.newUserMessage }] },
      ],
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
        // Gemini 2.5 models "think" before answering by default, and those
        // thinking tokens are drawn from the same maxOutputTokens budget as
        // the visible reply -- discovered live when a customer received a
        // reply truncated mid-sentence with finishReason "MAX_TOKENS" well
        // under what should have been a comfortable token budget. This task
        // (short, direct answers grounded in an injected knowledge base) has
        // no need for extended reasoning, so thinking is disabled outright
        // rather than just budgeted around -- removing the unpredictable
        // consumption at its source, not papering over it with a bigger
        // number that the same failure mode could still exceed later.
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const result = (await this.callApi("generateContent", body)) as GeminiGenerateContentBody;
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof text !== "string") {
      const blockReason = result.promptFeedback?.blockReason;
      const finishReason = result.candidates?.[0]?.finishReason;
      throw new GeminiApiError(
        `Gemini returned no usable text${blockReason ? ` (prompt blocked: ${blockReason})` : ""}` +
          `${finishReason ? ` (finish reason: ${finishReason})` : ""}.`,
        200
      );
    }

    // Defense in depth alongside disabling thinking above: even with
    // thinking off, a sufficiently long legitimate answer (e.g. a
    // multi-item order summary) could still hit maxOutputTokens. Surfacing
    // that here -- rather than only detecting the "no text at all" case
    // above -- lets the caller treat a truncated reply as unsafe to send,
    // the same way it already treats an unverified number as unsafe.
    const truncated = result.candidates?.[0]?.finishReason === FINISH_REASON_MAX_TOKENS;

    return { text, truncated };
  }

  async checkHealth(): Promise<void> {
    const url = `${this.baseUrl}/v1beta/models?key=${this.apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (cause) {
      throw new GeminiNetworkError("Network error checking Gemini API health.", cause);
    }
    if (!response.ok) {
      throw new GeminiApiError(`Gemini health check failed with status ${response.status}.`, response.status);
    }
  }

  private async callApi(method: string, body: unknown): Promise<unknown> {
    return callWithRetry((attemptNumber) => this.attemptApiCall(method, body, attemptNumber), {
      maxAttempts: this.maxAttempts,
      baseDelayMs: this.baseDelayMs,
      sleep: this.sleep,
      onRetry: (attemptNumber, delayMs, error) => {
        // Never log the URL -- it contains the API key. `method` is the
        // Gemini API method name (e.g. "generateContent"), safe to log.
        this.logger.warn("gemini_api.retry", { method, attemptNumber, delayMs, error: error.message });
      },
    });
  }

  private async attemptApiCall(method: string, body: unknown, _attemptNumber: number): Promise<AttemptResult<unknown>> {
    const url = `${this.baseUrl}/v1beta/models/${this.model}:${method}?key=${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      const error = new GeminiNetworkError(
        `Network error calling Gemini method "${method}". This is usually a connectivity issue rather ` +
          `than something wrong with the request itself -- it will be retried automatically.`,
        cause
      );
      this.logger.error("gemini_api.error", { method, retryable: true, error: error.message });
      return { outcome: "failure", failure: { error, retryable: true } };
    }

    if (response.ok) {
      return { outcome: "success", result: await response.json() };
    }

    const errorBody = (await response.json().catch(() => ({}))) as GeminiErrorBody;
    const statusCode = errorBody.error?.code ?? response.status;
    const error = new GeminiApiError(buildApiErrorMessage(method, statusCode, errorBody.error?.message), statusCode);
    const retryable = isRetryableGeminiError(statusCode);

    this.logger.error("gemini_api.error", { method, statusCode, retryable, error: error.message });

    return { outcome: "failure", failure: { error, retryable } };
  }
}

/** Builds an error message that explains what happened and, for the most common real cases, why and how to fix it. */
function buildApiErrorMessage(method: string, statusCode: number, description: string | undefined): string {
  const base = description ?? `Gemini API call "${method}" failed with status ${statusCode}.`;

  if (statusCode === 401 || statusCode === 403) {
    return `${base} This usually means GEMINI_API_KEY is invalid or doesn't have access to model requests -- check it in your .env file against the Google AI Studio / Google Cloud console.`;
  }

  if (statusCode === 404) {
    return `${base} This usually means the configured GEMINI_MODEL name doesn't exist or isn't available to this API key -- check the model name against Google's current model list.`;
  }

  return base;
}
