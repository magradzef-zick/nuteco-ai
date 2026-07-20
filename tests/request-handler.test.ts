import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createRequestHandler, type RequestHandler } from "../src/index";

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

function recordingHandler(calls: string[], label: string): RequestHandler {
  return (_req, res) => {
    calls.push(label);
    res.writeHead(200).end();
  };
}

test("GET /health returns 200 with a status payload, without touching either webhook handler", async () => {
  const calls: string[] = [];
  const server = createServer(
    createRequestHandler({
      telegramWebhookHandler: recordingHandler(calls, "telegram"),
      instagramWebhookHandler: recordingHandler(calls, "instagram"),
    })
  );
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.deepEqual(calls, [], "health check must not invoke either webhook handler");
  } finally {
    await closeServer(server);
  }
});

test("/telegram/webhook dispatches to the Telegram handler", async () => {
  const calls: string[] = [];
  const server = createServer(
    createRequestHandler({
      telegramWebhookHandler: recordingHandler(calls, "telegram"),
      instagramWebhookHandler: recordingHandler(calls, "instagram"),
    })
  );
  const baseUrl = await listen(server);

  try {
    await fetch(`${baseUrl}/telegram/webhook`, { method: "POST" });
    assert.deepEqual(calls, ["telegram"]);
  } finally {
    await closeServer(server);
  }
});

test("/instagram/webhook dispatches to the Instagram handler when one is configured", async () => {
  const calls: string[] = [];
  const server = createServer(
    createRequestHandler({
      telegramWebhookHandler: recordingHandler(calls, "telegram"),
      instagramWebhookHandler: recordingHandler(calls, "instagram"),
    })
  );
  const baseUrl = await listen(server);

  try {
    await fetch(`${baseUrl}/instagram/webhook`, { method: "GET" });
    assert.deepEqual(calls, ["instagram"]);
  } finally {
    await closeServer(server);
  }
});

test("/instagram/webhook 404s when no Instagram handler is configured (Telegram-only deployment)", async () => {
  const calls: string[] = [];
  const server = createServer(
    createRequestHandler({
      telegramWebhookHandler: recordingHandler(calls, "telegram"),
      instagramWebhookHandler: null,
    })
  );
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/instagram/webhook`, { method: "GET" });
    assert.equal(response.status, 404);
    assert.deepEqual(calls, []);
  } finally {
    await closeServer(server);
  }
});

test("an unrecognized path 404s", async () => {
  const calls: string[] = [];
  const server = createServer(
    createRequestHandler({
      telegramWebhookHandler: recordingHandler(calls, "telegram"),
      instagramWebhookHandler: recordingHandler(calls, "instagram"),
    })
  );
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/some/other/path`);
    assert.equal(response.status, 404);
    assert.deepEqual(calls, []);
  } finally {
    await closeServer(server);
  }
});
