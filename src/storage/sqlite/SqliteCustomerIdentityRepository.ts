import type { Database } from "better-sqlite3";
import {
  MAX_CONVERSATION_SUMMARY_LENGTH,
  type CustomerIdentity,
  type CustomerIdentityRepository,
} from "../CustomerIdentityRepository";

interface Row {
  customer_id: string;
  preferred_language: string | null;
  first_seen: number;
  last_seen: number;
  is_returning_customer: number;
  is_b2b: number;
  last_conversation_summary: string | null;
}

function rowToIdentity(row: Row): CustomerIdentity {
  return {
    customerId: row.customer_id,
    preferredLanguage: row.preferred_language,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    isReturningCustomer: row.is_returning_customer === 1,
    isB2b: row.is_b2b === 1,
    lastConversationSummary: row.last_conversation_summary,
  };
}

export class SqliteCustomerIdentityRepository implements CustomerIdentityRepository {
  constructor(private readonly db: Database) {}

  async findById(customerId: string): Promise<CustomerIdentity | null> {
    const row = this.db
      .prepare("SELECT * FROM customer_identity WHERE customer_id = ?")
      .get(customerId) as Row | undefined;
    return row ? rowToIdentity(row) : null;
  }

  async recordContact(
    customerId: string,
    now: number,
    preferredLanguage: string | null = null
  ): Promise<CustomerIdentity> {
    const existing = await this.findById(customerId);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO customer_identity
             (customer_id, preferred_language, first_seen, last_seen, is_returning_customer, is_b2b, last_conversation_summary)
           VALUES (?, ?, ?, ?, 0, 0, NULL)`
        )
        .run(customerId, preferredLanguage, now, now);
      return (await this.findById(customerId))!;
    }

    const languageToStore = preferredLanguage ?? existing.preferredLanguage;
    this.db
      .prepare(
        `UPDATE customer_identity
         SET last_seen = ?, preferred_language = ?, is_returning_customer = 1
         WHERE customer_id = ?`
      )
      .run(now, languageToStore, customerId);

    return (await this.findById(customerId))!;
  }

  async confirmB2b(customerId: string): Promise<void> {
    const result = this.db
      .prepare("UPDATE customer_identity SET is_b2b = 1 WHERE customer_id = ?")
      .run(customerId);
    if (result.changes === 0) {
      throw new Error(
        `Cannot confirm B2B for unknown customer "${customerId}" -- recordContact() must be called first.`
      );
    }
  }

  async recordConversationSummary(customerId: string, summary: string): Promise<void> {
    const truncated = summary.slice(0, MAX_CONVERSATION_SUMMARY_LENGTH);
    const result = this.db
      .prepare("UPDATE customer_identity SET last_conversation_summary = ? WHERE customer_id = ?")
      .run(truncated, customerId);
    if (result.changes === 0) {
      throw new Error(
        `Cannot record a conversation summary for unknown customer "${customerId}" -- recordContact() must be called first.`
      );
    }
  }
}
