import { test } from "node:test";
import assert from "node:assert/strict";
import { createShutdownHandler } from "../src/lifecycle/shutdown";
import { fakeLogger } from "./support/FakeLogger";

function fakeServer(options: { closeDelayMs?: number; neverCloses?: boolean } = {}) {
  let closeCalled = false;
  return {
    get closeCalled() {
      return closeCalled;
    },
    close: (callback: (err?: Error) => void) => {
      closeCalled = true;
      if (options.neverCloses) return; // simulate a hang -- callback is never invoked
      if (options.closeDelayMs) {
        setTimeout(() => callback(), options.closeDelayMs);
      } else {
        callback();
      }
    },
  };
}

function fakeExit(): { exit: (code: number) => void; calls: number[] } {
  const calls: number[] = [];
  return { calls, exit: (code: number) => void calls.push(code) };
}

test("a clean shutdown closes the server, releases resources, logs begin/complete, and exits 0", async () => {
  const server = fakeServer();
  const { logger, entries } = fakeLogger();
  const { exit, calls } = fakeExit();
  let resourcesClosed = false;

  const shutdown = createShutdownHandler({
    server,
    closeResources: () => void (resourcesClosed = true),
    logger,
    exit,
  });

  await shutdown("SIGTERM");

  assert.ok(server.closeCalled);
  assert.ok(resourcesClosed);
  assert.deepEqual(calls, [0]);
  assert.deepEqual(
    entries.map((e) => e.event),
    ["shutdown.begin", "shutdown.complete"]
  );
});

test("a second signal while shutdown is already in progress forces an immediate exit(1) instead of queuing", async () => {
  const server = fakeServer({ closeDelayMs: 30 });
  const { logger, entries } = fakeLogger();
  const { exit, calls } = fakeExit();

  const shutdown = createShutdownHandler({ server, closeResources: () => {}, logger, exit });

  const firstShutdown = shutdown("SIGINT"); // starts, but server.close() takes 30ms to call back
  await shutdown("SIGINT"); // a second signal arrives before the first finishes

  assert.deepEqual(calls, [1], "the repeated signal should force exit(1) immediately, before the first shutdown finishes");
  assert.ok(entries.some((e) => e.event === "shutdown.forced_by_repeated_signal"));

  await firstShutdown; // let the original shutdown finish so the test doesn't leave a dangling timer
});

test("if resource cleanup fails, the error is logged but shutdown still completes with exit(0)", async () => {
  const server = fakeServer();
  const { logger, entries } = fakeLogger();
  const { exit, calls } = fakeExit();

  const shutdown = createShutdownHandler({
    server,
    closeResources: () => {
      throw new Error("database was already closed");
    },
    logger,
    exit,
  });

  await shutdown("SIGTERM");

  assert.deepEqual(calls, [0], "a resource-cleanup failure shouldn't prevent a clean exit");
  assert.ok(entries.some((e) => e.event === "shutdown.resource_close_error"));
  assert.ok(entries.some((e) => e.event === "shutdown.complete"));
});

test("if the server never finishes closing, a forced exit(1) happens after the configured timeout", async () => {
  const server = fakeServer({ neverCloses: true });
  const { logger, entries } = fakeLogger();
  const { exit, calls } = fakeExit();

  const shutdown = createShutdownHandler({
    server,
    closeResources: () => {},
    logger,
    forceExitAfterMs: 20,
    exit,
  });

  // Deliberately not awaited -- server.close() never calls back, so this
  // promise would otherwise hang forever. The force-exit timer is what's
  // actually under test here.
  void shutdown("SIGTERM");

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(calls, [1]);
  assert.ok(entries.some((e) => e.event === "shutdown.forced_after_timeout"));
});
