import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/connection";

/**
 * Regression test for a real bug found during live validation: every
 * other test opens the database inside an already-existing temp
 * directory, so none of them exercised the very common real-world case
 * of a fresh checkout where DATABASE_PATH's parent directory doesn't
 * exist yet.
 */
test("creates the parent directory automatically if it doesn't exist yet", () => {
  const parentDir = mkdtempSync(join(tmpdir(), "nuteco-db-test-"));
  const nestedDir = join(parentDir, "does", "not", "exist", "yet");
  const dbPath = join(nestedDir, "nuteco.db");

  assert.equal(existsSync(nestedDir), false, "the nested directory must not exist before the call, or this test proves nothing");

  const db = openDatabase(dbPath);
  db.prepare("SELECT 1").get(); // proves the connection is actually usable, not just that a file exists
  db.close();

  assert.ok(existsSync(dbPath), "the database file should now exist");

  rmSync(parentDir, { recursive: true, force: true });
});

test("still works with an already-existing directory (the common case in every other test)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nuteco-db-test-"));
  const db = openDatabase(join(dir, "nuteco.db"));
  db.prepare("SELECT 1").get();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
