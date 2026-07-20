import type { Database } from "better-sqlite3";
import type { ProcessedMessageStore } from "../../engine/MessageDebouncer";

/**
 * How long a message ID is remembered after being processed. Only needs to
 * outlive the longest realistic delay before a duplicate redelivery or a
 * process restart could occur -- 7 days is generous headroom for both,
 * without letting the table grow unbounded forever.
 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * SQLite-backed ProcessedMessageStore: makes MessageDebouncer's dedup
 * survive process restarts, not just stay correct within a single run. Both
 * platform adapters already produce globally-unique message IDs (Telegram:
 * "<chatId>:<message_id>", Instagram: "<senderId>:<mid>"), so a single
 * table keyed only by message_id, with no customer column, is sufficient.
 */
export class SqliteProcessedMessageStore implements ProcessedMessageStore {
  constructor(private readonly db: Database) {}

  has(messageId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM processed_messages WHERE message_id = ?").get(messageId);
    return row !== undefined;
  }

  record(messageId: string): void {
    const now = Date.now();
    this.db
      .prepare("INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)")
      .run(messageId, now);
    this.db.prepare("DELETE FROM processed_messages WHERE processed_at < ?").run(now - RETENTION_MS);
  }
}
