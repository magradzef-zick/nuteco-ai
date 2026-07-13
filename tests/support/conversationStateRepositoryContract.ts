import assert from "node:assert/strict";
import type { ConversationStateRepository } from "../../src/storage/ConversationStateRepository";

/**
 * A shared behavioral contract that every ConversationStateRepository
 * implementation must satisfy -- see customerIdentityRepositoryContract.ts
 * for why this pattern exists.
 */
export async function verifyConversationStateRepositoryContract(
  createRepository: () => ConversationStateRepository
): Promise<void> {
  {
    const repo = createRepository();
    const missing = await repo.get("conv:1", 1000);
    assert.equal(missing, null, "a conversation that was never saved should return null");
  }

  {
    const repo = createRepository();
    const saved = await repo.save(
      {
        conversationId: "conv:2",
        currentIntent: "order",
        orderDraft: { product: "almond flour" },
        currentStep: "collecting_phone",
        pendingClarification: null,
        escalationFlag: false,
        variables: {},
      },
      1000,
      60_000
    );
    assert.equal(saved.expiresAt, 1000 + 60_000);

    const fetched = await repo.get("conv:2", 1500);
    assert.deepEqual(fetched?.orderDraft, { product: "almond flour" });
    assert.equal(fetched?.currentStep, "collecting_phone");
  }

  {
    // Expiration: a lookup after expiresAt must return null even though
    // deleteExpired() was never called -- correctness must never depend
    // on a cleanup job having run.
    const repo = createRepository();
    await repo.save(
      {
        conversationId: "conv:3",
        currentIntent: null,
        orderDraft: {},
        currentStep: null,
        pendingClarification: null,
        escalationFlag: false,
        variables: {},
      },
      1000,
      500
    );

    const stillAlive = await repo.get("conv:3", 1499);
    assert.notEqual(stillAlive, null, "should still be alive just before expiry");

    const expired = await repo.get("conv:3", 1500);
    assert.equal(expired, null, "should be treated as gone once expiresAt has passed");
  }

  {
    // State transitions: each save moves the conversation to a new step
    // and extends its expiry from that moment.
    const repo = createRepository();
    await repo.save(
      {
        conversationId: "conv:4",
        currentIntent: "order",
        orderDraft: {},
        currentStep: "collecting_name",
        pendingClarification: null,
        escalationFlag: false,
        variables: {},
      },
      1000,
      1000
    );

    await repo.save(
      {
        conversationId: "conv:4",
        currentIntent: "order",
        orderDraft: { name: "Aziz" },
        currentStep: "collecting_phone",
        pendingClarification: null,
        escalationFlag: false,
        variables: {},
      },
      1500,
      1000
    );

    const state = await repo.get("conv:4", 1600);
    assert.equal(state?.currentStep, "collecting_phone");
    assert.deepEqual(state?.orderDraft, { name: "Aziz" });
    assert.equal(state?.expiresAt, 1500 + 1000, "expiry should extend from the most recent save");
  }

  {
    const repo = createRepository();
    await repo.save(
      {
        conversationId: "conv:5",
        currentIntent: null,
        orderDraft: {},
        currentStep: null,
        pendingClarification: null,
        escalationFlag: true,
        variables: { attempts: 2 },
      },
      1000,
      1000
    );

    await repo.clear("conv:5");
    const state = await repo.get("conv:5", 1000);
    assert.equal(state, null, "clear() should remove the state outright");
  }

  {
    const repo = createRepository();
    await repo.save(
      {
        conversationId: "conv:6",
        currentIntent: null,
        orderDraft: {},
        currentStep: null,
        pendingClarification: null,
        escalationFlag: false,
        variables: {},
      },
      1000,
      500
    );
    await repo.save(
      {
        conversationId: "conv:7",
        currentIntent: null,
        orderDraft: {},
        currentStep: null,
        pendingClarification: null,
        escalationFlag: false,
        variables: {},
      },
      1000,
      5000
    );

    const deletedCount = await repo.deleteExpired(1600);
    assert.equal(deletedCount, 1, "only conv:6 should have expired by t=1600");

    assert.equal(await repo.get("conv:6", 1600), null);
    assert.notEqual(await repo.get("conv:7", 1600), null);
  }
}
