import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/connection";
import { SqliteConversationStateRepository } from "../src/storage/sqlite/SqliteConversationStateRepository";
import { InMemoryConversationStateRepository } from "../src/storage/memory/InMemoryConversationStateRepository";
import { verifyConversationStateRepositoryContract } from "./support/conversationStateRepositoryContract";

test("InMemoryConversationStateRepository satisfies the repository contract", async () => {
  await verifyConversationStateRepositoryContract(() => new InMemoryConversationStateRepository());
});

test("SqliteConversationStateRepository satisfies the repository contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nuteco-state-test-"));
  const db = openDatabase(join(dir, "test.db"));

  await verifyConversationStateRepositoryContract(() => {
    db.exec("DELETE FROM conversation_state");
    return new SqliteConversationStateRepository(db);
  });

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
