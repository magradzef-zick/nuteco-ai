import {
  MAX_CONVERSATION_SUMMARY_LENGTH,
  type CustomerIdentity,
  type CustomerIdentityRepository,
} from "../CustomerIdentityRepository";

/**
 * An in-memory implementation of CustomerIdentityRepository. Useful for
 * fast tests, and anywhere persistence isn't wired up yet. It satisfies
 * the exact same interface and behavioral contract as the SQLite
 * implementation -- that's the point of the interface: the Conversation
 * Engine never needs to know which one it's talking to.
 */
export class InMemoryCustomerIdentityRepository implements CustomerIdentityRepository {
  private readonly records = new Map<string, CustomerIdentity>();

  async findById(customerId: string): Promise<CustomerIdentity | null> {
    return this.records.get(customerId) ?? null;
  }

  async recordContact(
    customerId: string,
    now: number,
    preferredLanguage: string | null = null
  ): Promise<CustomerIdentity> {
    const existing = this.records.get(customerId);

    if (!existing) {
      const created: CustomerIdentity = {
        customerId,
        preferredLanguage,
        firstSeen: now,
        lastSeen: now,
        isReturningCustomer: false,
        isB2b: false,
        lastConversationSummary: null,
      };
      this.records.set(customerId, created);
      return created;
    }

    const updated: CustomerIdentity = {
      ...existing,
      lastSeen: now,
      preferredLanguage: preferredLanguage ?? existing.preferredLanguage,
      isReturningCustomer: true,
    };
    this.records.set(customerId, updated);
    return updated;
  }

  async confirmB2b(customerId: string): Promise<void> {
    const existing = this.records.get(customerId);
    if (!existing) {
      throw new Error(
        `Cannot confirm B2B for unknown customer "${customerId}" -- recordContact() must be called first.`
      );
    }
    this.records.set(customerId, { ...existing, isB2b: true });
  }

  async recordConversationSummary(customerId: string, summary: string): Promise<void> {
    const existing = this.records.get(customerId);
    if (!existing) {
      throw new Error(
        `Cannot record a conversation summary for unknown customer "${customerId}" -- recordContact() must be called first.`
      );
    }
    this.records.set(customerId, {
      ...existing,
      lastConversationSummary: summary.slice(0, MAX_CONVERSATION_SUMMARY_LENGTH),
    });
  }
}
