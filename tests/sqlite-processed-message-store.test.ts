import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/connection";
import { SqliteProcessedMessageStore } from "../src/storage/sqlite/SqliteProcessedMessageStore";

function withTempDb(fn: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nuteco-processed-messages-test-"));
  try {
    fn(join(dir, "nuteco.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("has() is false for a message that was never recorded", () => {
  withTempDb((dbPath) => {
    const db = openDatabase(dbPath);
    const store = new SqliteProcessedMessageStore(db);
    assert.equal(store.has("never-seen"), false);
    db.close();
  });
});

test("record() then has() returns true, including from a second store instance sharing the same database file", () => {
  withTempDb((dbPath) => {
    const db = openDatabase(dbPath);
    new SqliteProcessedMessageStore(db).record("m1");
    db.close();

    // Simulates a process restart: a fresh connection to the same file.
    const reopened = openDatabase(dbPath);
    const store = new SqliteProcessedMessageStore(reopened);
    assert.equal(store.has("m1"), true);
    reopened.close();
  });
});

test("recording the same message ID twice does not throw (INSERT OR IGNORE)", () => {
  withTempDb((dbPath) => {
    const db = openDatabase(dbPath);
    const store = new SqliteProcessedMessageStore(db);
    store.record("m1");
    assert.doesNotThrow(() => store.record("m1"));
    assert.equal(store.has("m1"), true);
    db.close();
  });
});
