import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { createInstagramWebhookHandler } from "../src/adapters/instagram/webhookRouter";
import { MessageDebouncer } from "../src/engine/MessageDebouncer";
import { createInstagramRedirectHandler } from "../src/engine/instagramRedirectHandler";
import { InstagramMessageSender } from "../src/adapters/instagram/InstagramMessageSender";
import { FakeInstagramTransport } from "./support/FakeInstagramTransport";
import { fakeLogger } from "./support/FakeLogger";
import { handleIncomingInstagramUpdate } from "../src/composition";

const TEST_APP_SECRET = "test-app-secret";

/**
 * Full-pipeline integration tests for the Instagram adapter: a real local
 * HTTP server hosting the real webhook handler, receiving real HTTP
 * requests (via fetch) shaped like Meta's Instagram messaging webhook
 * deliveries, flowing through the real parser, the real debouncer, and
 * the real redirect-to-Telegram handler (see instagramRedirectHandler.ts)
 * -- with only the Graph API faked, via FakeInstagramTransport. Mirrors
 * telegram-webhook-integration.test.ts's structure exactly, except
 * Telegram still goes through the full ConversationEngine and Instagram
 * doesn't -- see composition.ts's AppDependencies doc comment for why.
 */
function setupServer(options: { appSecret?: string | null; verifyToken?: string } = {}) {
  const transport = new FakeInstagramTransport();
  const messageSender = new InstagramMessageSender({ transport, sleep: async () => {} });
  const debouncer = new MessageDebouncer();
  const { logger, entries: logEntries } = fakeLogger();
  const instagramHandleMessages = createInstagramRedirectHandler({ messageSender, logger });

  const webhookHandler = createInstagramWebhookHandler({
    verifyToken: options.verifyToken ?? "test-verify-token",
    appSecret: options.appSecret === undefined ? TEST_APP_SECRET : options.appSecret,
    onEvent: (event) => handleIncomingInstagramUpdate(event, { debouncer, instagramHandleMessages, logger }),
    logger,
  });

  const server = createServer(webhookHandler);

  return { server, transport, logEntries };
}

/** Fails the test loudly if anything logged an unexpected processing error. Mirrors telegram-webhook-integration.test.ts's assertNoUnexpectedProcessingErrors. */
function assertNoUnexpectedProcessingErrors(logEntries: ReturnType<typeof fakeLogger>["entries"]) {
  const unexpected = logEntries.filter((e) => e.event === "webhook.processing_error");
  assert.equal(unexpected.length, 0, `unexpected processing error(s) logged: ${JSON.stringify(unexpected)}`);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function instagramWebhookPayload(senderId: string, mid: string, text: string) {
  return {
    object: "instagram",
    entry: [
      {
        id: "17841400000000000",
        time: 1_700_000_000_000,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: "17841400000000000" },
            timestamp: 1_700_000_000_123,
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

function signBody(body: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

async function post(baseUrl: string, path: string, body: unknown, appSecret: string | null = TEST_APP_SECRET) {
  const serialized = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (appSecret) {
    headers["x-hub-signature-256"] = signBody(serialized, appSecret);
  }
  return fetch(`${baseUrl}${path}`, { method: "POST", headers, body: serialized });
}

test("a real text message flows end-to-end: 200 ack, redirect-to-Telegram reply sent, no LLM/identity involved", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const body = instagramWebhookPayload("555555555555555", "mid.1", "What's the price of almond flour?");
    const response = await post(baseUrl, "/instagram/webhook", body);
    assert.equal(response.status, 200);

    await new Promise((resolve) => setImmediate(resolve));

    // No typing indicator: this is a fixed template, not a generated
    // reply, so there's nothing to show "thinking" for.
    assert.deepEqual(transport.calls.map((c) => c.method), ["sendMessage"], "should send exactly one reply, no typing indicator");
    const sent = transport.calls.find((c) => c.method === "sendMessage");
    assert.ok(sent && sent.method === "sendMessage" && sent.text.includes("t.me/NutecoPremium"), "reply should be the Telegram redirect template");

    assertNoUnexpectedProcessingErrors(logEntries);
    assert.ok(logEntries.some((e) => e.event === "webhook.received"));
    assert.ok(logEntries.some((e) => e.event === "conversation.started" && e.fields.customerId === "instagram:555555555555555"));
    assert.ok(logEntries.some((e) => e.event === "conversation.ended" && e.fields.customerId === "instagram:555555555555555"));
  } finally {
    await closeServer(server);
  }
});

test("a duplicate webhook delivery of the same message results in only one reply, not two", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const body = instagramWebhookPayload("555555555555556", "mid.2", "Hello");

    const first = await post(baseUrl, "/instagram/webhook", body);
    assert.equal(first.status, 200);
    await new Promise((resolve) => setImmediate(resolve));

    const second = await post(baseUrl, "/instagram/webhook", body);
    assert.equal(second.status, 200, "the webhook should still ack a duplicate, not error");
    await new Promise((resolve) => setImmediate(resolve));

    const sendCount = transport.calls.filter((c) => c.method === "sendMessage").length;
    assert.equal(sendCount, 1, "the duplicate delivery must not trigger a second reply");

    assertNoUnexpectedProcessingErrors(logEntries);
    assert.ok(logEntries.some((e) => e.event === "message.duplicate_ignored"));
  } finally {
    await closeServer(server);
  }
});

test("a batched webhook POST with two messaging events answers both", async () => {
  const { server, transport } = setupServer();
  const baseUrl = await listen(server);

  try {
    const batched = {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1_700_000_000_000,
          messaging: [
            { sender: { id: "1" }, recipient: { id: "p" }, timestamp: 1, message: { mid: "mid.a", text: "First question" } },
            { sender: { id: "2" }, recipient: { id: "p" }, timestamp: 2, message: { mid: "mid.b", text: "Second question" } },
          ],
        },
      ],
    };

    const response = await post(baseUrl, "/instagram/webhook", batched);
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));

    const sendCount = transport.calls.filter((c) => c.method === "sendMessage").length;
    assert.equal(sendCount, 2, "both messages in the batch should each get a reply");
  } finally {
    await closeServer(server);
  }
});

test("a message echoed back from the page itself is ignored, not answered", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const body = {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1,
          messaging: [
            {
              sender: { id: "17841400000000000" },
              recipient: { id: "1" },
              timestamp: 1,
              message: { mid: "mid.echo", text: "Our own reply", is_echo: true },
            },
          ],
        },
      ],
    };

    const response = await post(baseUrl, "/instagram/webhook", body);
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(transport.calls.length, 0);
    assertNoUnexpectedProcessingErrors(logEntries);
    assert.ok(logEntries.some((e) => e.event === "webhook.update_unsupported" && e.fields.updateType === "message_echo"));
  } finally {
    await closeServer(server);
  }
});

test("the GET verification handshake succeeds and echoes the challenge", async () => {
  const { server } = setupServer({ verifyToken: "my-verify-token" });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(
      `${baseUrl}/instagram/webhook?hub.mode=subscribe&hub.verify_token=my-verify-token&hub.challenge=12345`,
      { method: "GET" }
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "12345");
  } finally {
    await closeServer(server);
  }
});

test("the GET verification handshake is rejected with 403 on a wrong verify token", async () => {
  const { server } = setupServer({ verifyToken: "my-verify-token" });
  const baseUrl = await listen(server);

  try {
    const response = await fetch(
      `${baseUrl}/instagram/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=12345`,
      { method: "GET" }
    );
    assert.equal(response.status, 403);
  } finally {
    await closeServer(server);
  }
});

test("a POST with a missing signature is rejected with 401 when an app secret is configured", async () => {
  const { server, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const body = instagramWebhookPayload("1", "mid.x", "Hi");
    const response = await fetch(`${baseUrl}/instagram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401);
    assert.ok(logEntries.some((e) => e.event === "webhook.rejected_unauthorized"));
  } finally {
    await closeServer(server);
  }
});

test("a POST with an incorrect signature is rejected with 401", async () => {
  const { server } = setupServer();
  const baseUrl = await listen(server);

  try {
    const body = instagramWebhookPayload("1", "mid.x", "Hi");
    const response = await fetch(`${baseUrl}/instagram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401);
  } finally {
    await closeServer(server);
  }
});

test("a POST with the correct signature is accepted", async () => {
  const { server, transport } = setupServer();
  const baseUrl = await listen(server);

  try {
    const body = instagramWebhookPayload("999", "mid.y", "Hi");
    const response = await post(baseUrl, "/instagram/webhook", body);
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(transport.calls.some((c) => c.method === "sendMessage"));
  } finally {
    await closeServer(server);
  }
});

test("a request with no app secret configured skips the signature check entirely", async () => {
  const { server, transport } = setupServer({ appSecret: null });
  const baseUrl = await listen(server);

  try {
    const body = instagramWebhookPayload("888", "mid.z", "Hi");
    const response = await fetch(`${baseUrl}/instagram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(transport.calls.some((c) => c.method === "sendMessage"));
  } finally {
    await closeServer(server);
  }
});

test("a non-GET, non-POST request is rejected with 405", async () => {
  const { server, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/instagram/webhook`, { method: "DELETE" });
    assert.equal(response.status, 405);
    assert.ok(logEntries.some((e) => e.event === "webhook.rejected_method"));
  } finally {
    await closeServer(server);
  }
});

test("a malformed JSON body is acknowledged (so Meta stops retrying it) but produces no reply", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const rawBody = "{ this is not valid json";
    const response = await fetch(`${baseUrl}/instagram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signBody(rawBody, TEST_APP_SECRET) },
      body: rawBody,
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.calls.length, 0);
    assert.ok(logEntries.some((e) => e.event === "webhook.parse_error"));
  } finally {
    await closeServer(server);
  }
});

test("a request body over the size limit is rejected with 413, checked before signature verification", async () => {
  const { server, transport, logEntries } = setupServer();
  const baseUrl = await listen(server);

  try {
    const oversized = "x".repeat(1_000_001);
    const response = await fetch(`${baseUrl}/instagram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    assert.equal(response.status, 413);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.calls.length, 0);
    assert.ok(logEntries.some((e) => e.event === "webhook.rejected_body_too_large"));
  } finally {
    await closeServer(server);
  }
});
