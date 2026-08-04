import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider, GeminiApiError, GeminiNetworkError } from "../src/llm/gemini/GeminiProvider";
import { fakeLogger } from "./support/FakeLogger";

interface RecordedRequest {
  url: string;
  body: unknown;
}

function fakeFetch(script: Array<Response | Error>) {
  const requests: RecordedRequest[] = [];
  let callIndex = 0;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const next = script[callIndex];
    callIndex++;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;

  return { fetchImpl, requests };
}

function okGenerateResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }],
    }),
    { status: 200 }
  );
}

function truncatedGenerateResponse(partialText: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: partialText }], role: "model" }, finishReason: "MAX_TOKENS" }],
    }),
    { status: 200 }
  );
}

function errorResponse(statusCode: number, message: string, details?: unknown[]): Response {
  return new Response(
    JSON.stringify({ error: { code: statusCode, message, status: "ERROR", details } }),
    { status: statusCode }
  );
}

/** Gemini's real shape for "wait this long before retrying" on a 429. */
function quotaExceededResponse(retryDelay: string): Response {
  return errorResponse(429, "You exceeded your current quota, please check your plan and billing details.", [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
  ]);
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

test("generateReply sends the system prompt, history, and new message in Gemini's expected shape", async () => {
  const { fetchImpl, requests } = fakeFetch([okGenerateResponse("150.000 per kg.")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl });

  const result = await provider.generateReply({
    systemPrompt: "You are the Nuteco assistant.",
    historyTurns: [
      { role: "user", text: "What products do you have?" },
      { role: "assistant", text: "Almond flour, pistachio paste, and more." },
    ],
    newUserMessage: "How much is almond flour?",
  });

  assert.equal(result.text, "150.000 per kg.");
  assert.equal(result.truncated, false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /models\/gemini-2\.5-flash:generateContent/);

  const body = requests[0].body as any;
  assert.equal(body.system_instruction.parts[0].text, "You are the Nuteco assistant.");
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "What products do you have?" }] },
    { role: "model", parts: [{ text: "Almond flour, pistachio paste, and more." }] },
    { role: "user", parts: [{ text: "How much is almond flour?" }] },
  ]);
});

test("disables Gemini's thinking so it can't silently consume the output token budget meant for the visible reply", async () => {
  const { fetchImpl, requests } = fakeFetch([okGenerateResponse("ok")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl });

  await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  const body = requests[0].body as any;
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test("a reply cut off by the output token limit is reported as truncated, not treated as a complete success (root cause of a real bug seen live: a customer received a reply that stopped mid-sentence with no continuation)", async () => {
  const { fetchImpl } = fakeFetch([truncatedGenerateResponse("Здравствуйте! У нас есть в наличии фисташковая, фундучная, ке")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl });

  const result = await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  assert.equal(result.truncated, true);
  assert.equal(result.text, "Здравствуйте! У нас есть в наличии фисташковая, фундучная, ке", "the partial text is still returned -- the caller decides what to do with it");
});

test("checkHealth succeeds when the models endpoint responds ok", async () => {
  const { fetchImpl } = fakeFetch([new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }] }), { status: 200 })]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl });
  await provider.checkHealth(); // should not throw
});

test("checkHealth throws a clear error on an invalid key", async () => {
  const { fetchImpl } = fakeFetch([errorResponse(400, "API key not valid")]);
  const provider = new GeminiProvider({ apiKey: "BAD_KEY", model: "gemini-2.5-flash", fetchImpl });
  await assert.rejects(() => provider.checkHealth(), GeminiApiError);
});

test("retries a 429 and eventually succeeds", async () => {
  const { sleep, delays } = recordingSleep();
  const { fetchImpl, requests } = fakeFetch([errorResponse(429, "Resource exhausted"), okGenerateResponse("ok")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 3 });

  const result = await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  assert.equal(result.text, "ok");
  assert.equal(requests.length, 2);
  assert.equal(delays.length, 1);
});

test("honors Gemini's own RetryInfo delay on a quota-exceeded 429 instead of the generic backoff (real production case: a customer's question failed because the previous exponential backoff -- under 1.5s total -- never came close to the 15-50s Gemini actually asks for)", async () => {
  const { sleep, delays } = recordingSleep();
  const { fetchImpl } = fakeFetch([quotaExceededResponse("27s"), okGenerateResponse("ok")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 3 });

  const result = await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  assert.equal(result.text, "ok");
  assert.deepEqual(delays, [27_000]);
});

test("a fractional RetryInfo delay is honored precisely, not rounded", async () => {
  const { sleep, delays } = recordingSleep();
  const { fetchImpl } = fakeFetch([quotaExceededResponse("1.5s"), okGenerateResponse("ok")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 3 });

  await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  assert.deepEqual(delays, [1_500]);
});

test("an implausibly large RetryInfo delay is capped rather than honored outright", async () => {
  const { sleep, delays } = recordingSleep();
  const { fetchImpl } = fakeFetch([quotaExceededResponse("900s"), okGenerateResponse("ok")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 3 });

  await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  assert.deepEqual(delays, [60_000]);
});

test("a 429 with no RetryInfo (a different rate-limit shape) falls back to the generic exponential backoff", async () => {
  const { sleep, delays } = recordingSleep();
  const { fetchImpl } = fakeFetch([errorResponse(429, "Too many requests"), okGenerateResponse("ok")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 3, baseDelayMs: 500 });

  await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  assert.deepEqual(delays, [500]);
});

test("does not retry a 400 (bad request) -- fails immediately", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl, requests } = fakeFetch([errorResponse(400, "Invalid argument")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 5 });

  await assert.rejects(
    () => provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" }),
    (error: unknown) => {
      assert.ok(error instanceof GeminiApiError);
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
  assert.equal(requests.length, 1);
});

test("a 401/403 error message explains it's likely an invalid API key", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl } = fakeFetch([errorResponse(403, "PERMISSION_DENIED")]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 1 });

  await assert.rejects(
    () => provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" }),
    /GEMINI_API_KEY is invalid/
  );
});

test("retries a network-level failure and eventually throws GeminiNetworkError", async () => {
  const { sleep } = recordingSleep();
  const networkError = new TypeError("fetch failed");
  const { fetchImpl, requests } = fakeFetch([networkError, networkError, networkError]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, sleep, maxAttempts: 3 });

  await assert.rejects(() => provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" }), GeminiNetworkError);
  assert.equal(requests.length, 3);
});

test("throws a clear error if Gemini returns no candidates (e.g. a blocked prompt)", async () => {
  const { fetchImpl } = fakeFetch([
    new Response(JSON.stringify({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }),
  ]);
  const provider = new GeminiProvider({ apiKey: "FAKE_KEY", model: "gemini-2.5-flash", fetchImpl, maxAttempts: 1 });

  await assert.rejects(
    () => provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" }),
    /prompt blocked: SAFETY/
  );
});

test("logs gemini_api.error and gemini_api.retry without ever including the API key", async () => {
  const { sleep } = recordingSleep();
  const { logger, entries } = fakeLogger();
  const { fetchImpl } = fakeFetch([errorResponse(500, "Internal error"), okGenerateResponse("ok")]);
  const provider = new GeminiProvider({
    apiKey: "AIzaSyExampleKeyText1234567890abcdefg",
    model: "gemini-2.5-flash",
    fetchImpl,
    sleep,
    maxAttempts: 3,
    logger,
  });

  await provider.generateReply({ systemPrompt: "sp", historyTurns: [], newUserMessage: "hi" });

  assert.equal(entries.filter((e) => e.event === "gemini_api.error").length, 1);
  assert.equal(entries.filter((e) => e.event === "gemini_api.retry").length, 1);

  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /AIzaSyExampleKeyText1234567890abcdefg/, "the API key must never appear in any logged field");
});
