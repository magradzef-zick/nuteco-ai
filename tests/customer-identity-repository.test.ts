import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/sqlite/connection";
import { SqliteCustomerIdentityRepository } from "../src/storage/sqlite/SqliteCustomerIdentityRepository";
import { InMemoryCustomerIdentityRepository } from "../src/storage/memory/InMemoryCustomerIdentityRepository";
import { verifyCustomerIdentityRepositoryContract } from "./support/customerIdentityRepositoryContract";

test("InMemoryCustomerIdentityRepository satisfies the repository contract", async () => {
  await verifyCustomerIdentityRepositoryContract(() => new InMemoryCustomerIdentityRepository());
});

test("SqliteCustomerIdentityRepository satisfies the repository contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nuteco-identity-test-"));
  const db = openDatabase(join(dir, "test.db"));

  await verifyCustomerIdentityRepositoryContract(() => {
    // Each scenario in the contract expects a fresh repository, so clear
    // the table between calls while reusing the one open connection.
    db.exec("DELETE FROM customer_identity");
    return new SqliteCustomerIdentityRepository(db);
  });

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
