import assert from "node:assert/strict";
import type { CustomerIdentityRepository } from "../../src/storage/CustomerIdentityRepository";

/**
 * A shared behavioral contract that every CustomerIdentityRepository
 * implementation must satisfy. Run against both the in-memory and the
 * SQLite implementation so the interface actually guarantees something --
 * the Conversation Engine needs both to behave identically, not just have
 * matching type signatures.
 */
export async function verifyCustomerIdentityRepositoryContract(
  createRepository: () => CustomerIdentityRepository
): Promise<void> {
  {
    const repo = createRepository();
    const found = await repo.findById("telegram:unknown");
    assert.equal(found, null, "unknown customers should return null, not throw");
  }

  {
    const repo = createRepository();
    const first = await repo.recordContact("telegram:1", 1000, "ru");
    assert.equal(first.isReturningCustomer, false, "first contact is not a returning customer");
    assert.equal(first.firstSeen, 1000);
    assert.equal(first.lastSeen, 1000);
    assert.equal(first.preferredLanguage, "ru");

    const second = await repo.recordContact("telegram:1", 2000, "uz");
    assert.equal(second.isReturningCustomer, true, "second contact marks them returning");
    assert.equal(second.firstSeen, 1000, "firstSeen must never change once set");
    assert.equal(second.lastSeen, 2000);
    assert.equal(second.preferredLanguage, "uz", "the most recent message's language should win");
  }

  {
    const repo = createRepository();
    await repo.recordContact("telegram:2", 1000, "ru");
    const notMentioned = await repo.recordContact("telegram:2", 2000);
    assert.equal(
      notMentioned.preferredLanguage,
      "ru",
      "omitting the language argument should keep the previously stored value"
    );
  }

  {
    const repo = createRepository();
    await repo.recordContact("telegram:3", 1000);
    await repo.confirmB2b("telegram:3");
    const identity = await repo.findById("telegram:3");
    assert.equal(identity?.isB2b, true);

    // Confirming again, and further ordinary contact, must never un-set it.
    await repo.confirmB2b("telegram:3");
    await repo.recordContact("telegram:3", 2000, "en");
    const stillB2b = await repo.findById("telegram:3");
    assert.equal(stillB2b?.isB2b, true, "isB2b must never be silently cleared by ordinary contact");
  }

  {
    const repo = createRepository();
    await assert.rejects(
      () => repo.confirmB2b("telegram:never-seen"),
      /recordContact/,
      "confirming B2B for an unknown customer should fail loudly, not silently create a record"
    );
  }

  {
    const repo = createRepository();
    await repo.recordContact("telegram:4", 1000);
    await repo.recordConversationSummary("telegram:4", "Asked about almond flour, ordered 2kg.");
    const identity = await repo.findById("telegram:4");
    assert.equal(identity?.lastConversationSummary, "Asked about almond flour, ordered 2kg.");
  }

  {
    const repo = createRepository();
    await repo.recordContact("telegram:5", 1000);
    const longSummary = "x".repeat(500);
    await repo.recordConversationSummary("telegram:5", longSummary);
    const identity = await repo.findById("telegram:5");
    assert.equal(
      identity?.lastConversationSummary?.length,
      200,
      "summaries must be truncated -- this is a greeting hint, not a transcript archive"
    );
  }

  {
    const repo = createRepository();
    await assert.rejects(
      () => repo.recordConversationSummary("telegram:never-seen-2", "hi"),
      /recordContact/,
      "recording a summary for an unknown customer should fail loudly"
    );
  }
}
