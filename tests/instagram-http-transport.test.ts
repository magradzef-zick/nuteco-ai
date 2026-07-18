import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpInstagramTransport } from "../src/adapters/instagram/HttpInstagramTransport";
import { InstagramApiError, InstagramNetworkError } from "../src/adapters/instagram/InstagramTransport";
import { fakeLogger } from "./support/FakeLogger";

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** A queue of canned responses (or thrown errors) a fake `fetch` hands out in order, recording every call it received. Mirrors telegram-http-transport.test.ts's fakeFetch. */
function fakeFetch(script: Array<Response | Error>) {
  const requests: RecordedRequest[] = [];
  let callIndex = 0;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, method: (init?.method as string) ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    const next = script[callIndex];
    callIndex++;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as typeof fetch;

  return { fetchImpl, requests, callCount: () => callIndex };
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify(result), { status: 200 });
}

function errorResponse(statusCode: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "OAuthException", code: statusCode } }), { status: statusCode });
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

test("sendMessage posts to me/messages with the recipient id, text, and access token", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse({ message_id: "m1" })]);
  const transport = new HttpInstagramTransport({ pageAccessToken: "PAGE_TOKEN", pageId: "17841400000000000", fetchImpl });

  await transport.sendMessage("123456", "Hello!");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.ok(requests[0].url.startsWith("https://graph.facebook.com/v21.0/me/messages?access_token=PAGE_TOKEN"));
  assert.deepEqual(requests[0].body, { recipient: { id: "123456" }, message: { text: "Hello!" } });
});

test("sendSenderAction posts the typing_on sender action", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse({ success: true })]);
  const transport = new HttpInstagramTransport({ pageAccessToken: "PAGE_TOKEN", pageId: "17841400000000000", fetchImpl });

  await transport.sendSenderAction("123456", "typing_on");

  assert.deepEqual(requests[0].body, { recipient: { id: "123456" }, sender_action: "typing_on" });
});

test("getProfile returns the connected account's identity", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse({ id: "17841400000000000", username: "nuteco_premium" })]);
  const transport = new HttpInstagramTransport({ pageAccessToken: "PAGE_TOKEN", pageId: "17841400000000000", fetchImpl });

  const profile = await transport.getProfile();

  assert.deepEqual(profile, { id: "17841400000000000", username: "nuteco_premium" });
  assert.equal(requests[0].method, "GET");
  assert.ok(requests[0].url.includes("/me?"));
  assert.ok(requests[0].url.includes("fields=id%2Cusername") || requests[0].url.includes("fields=id,username"));
});

test("subscribeWebhookFields posts to <pageId>/subscribed_apps with the joined field list", async () => {
  const { fetchImpl, requests } = fakeFetch([okResponse({ success: true })]);
  const transport = new HttpInstagramTransport({ pageAccessToken: "PAGE_TOKEN", pageId: "17841400000000000", fetchImpl });

  await transport.subscribeWebhookFields(["messages"]);

  assert.ok(requests[0].url.includes("/17841400000000000/subscribed_apps"));
  assert.ok(requests[0].url.includes("subscribed_fields=messages"));
});

test("retries a 5xx error and eventually gives up, throwing InstagramApiError", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl, requests } = fakeFetch([
    errorResponse(500, "Internal error"),
    errorResponse(503, "Service unavailable"),
    errorResponse(500, "Internal error"),
  ]);
  const transport = new HttpInstagramTransport({
    pageAccessToken: "PAGE_TOKEN",
    pageId: "17841400000000000",
    fetchImpl,
    sleep,
    maxAttempts: 3,
  });

  await assert.rejects(() => transport.sendMessage("123456", "hi"), InstagramApiError);
  assert.equal(requests.length, 3);
});

test("does not retry a 400 (bad request) -- fails immediately", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl, requests } = fakeFetch([errorResponse(400, "Invalid recipient")]);
  const transport = new HttpInstagramTransport({
    pageAccessToken: "PAGE_TOKEN",
    pageId: "17841400000000000",
    fetchImpl,
    sleep,
    maxAttempts: 5,
  });

  await assert.rejects(() => transport.sendMessage("123456", "hi"), (error: unknown) => {
    assert.ok(error instanceof InstagramApiError);
    assert.equal(error.statusCode, 400);
    return true;
  });
  assert.equal(requests.length, 1, "a non-retryable error should not be retried");
});

test("retries a network-level failure and eventually throws InstagramNetworkError", async () => {
  const { sleep } = recordingSleep();
  const networkError = new TypeError("fetch failed");
  const { fetchImpl, requests } = fakeFetch([networkError, networkError, networkError]);
  const transport = new HttpInstagramTransport({
    pageAccessToken: "PAGE_TOKEN",
    pageId: "17841400000000000",
    fetchImpl,
    sleep,
    maxAttempts: 3,
  });

  await assert.rejects(() => transport.sendMessage("123456", "hi"), InstagramNetworkError);
  assert.equal(requests.length, 3);
});

test("a 401 error message explains the page access token is likely invalid", async () => {
  const { sleep } = recordingSleep();
  const { fetchImpl } = fakeFetch([errorResponse(401, "Invalid OAuth access token")]);
  const transport = new HttpInstagramTransport({
    pageAccessToken: "PAGE_TOKEN",
    pageId: "17841400000000000",
    fetchImpl,
    sleep,
    maxAttempts: 1,
  });

  await assert.rejects(() => transport.getProfile(), /INSTAGRAM_PAGE_ACCESS_TOKEN is invalid.*Meta App Dashboard/s);
});

test("logs instagram_api.error on every failed call, without ever including the page access token", async () => {
  const { sleep } = recordingSleep();
  const { logger, entries } = fakeLogger();
  const { fetchImpl } = fakeFetch([errorResponse(400, "Invalid recipient")]);
  const transport = new HttpInstagramTransport({
    pageAccessToken: "SECRET_PAGE_TOKEN_VALUE",
    pageId: "17841400000000000",
    fetchImpl,
    sleep,
    maxAttempts: 1,
    logger,
  });

  await assert.rejects(() => transport.sendMessage("123456", "hi"));

  const errorLogs = entries.filter((e) => e.event === "instagram_api.error");
  assert.equal(errorLogs.length, 1);
  assert.equal(errorLogs[0].fields.path, "me/messages");
  assert.equal(errorLogs[0].fields.statusCode, 400);
  assert.equal(errorLogs[0].fields.retryable, false);

  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /SECRET_PAGE_TOKEN_VALUE/, "the page access token must never appear in any logged field");
});

test("logs instagram_api.retry once per retry, and instagram_api.error for the underlying failure", async () => {
  const { sleep } = recordingSleep();
  const { logger, entries } = fakeLogger();
  const { fetchImpl } = fakeFetch([errorResponse(500, "Internal error"), okResponse({ message_id: "m1" })]);
  const transport = new HttpInstagramTransport({
    pageAccessToken: "PAGE_TOKEN",
    pageId: "17841400000000000",
    fetchImpl,
    sleep,
    maxAttempts: 3,
    logger,
  });

  await transport.sendMessage("123456", "hi");

  assert.equal(entries.filter((e) => e.event === "instagram_api.error").length, 1);
  assert.equal(entries.filter((e) => e.event === "instagram_api.retry").length, 1);
});
