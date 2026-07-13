import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opens (or creates) the SQLite database file and ensures the schema
 * exists. Call once per process; the returned handle is shared by all
 * SQLite repository implementations.
 *
 * Uses `better-sqlite3` rather than Node's newer built-in `node:sqlite`
 * module: the built-in module is still explicitly experimental and its
 * availability depends on exactly which Node version this ends up
 * deployed on. `better-sqlite3` is a mature, widely-deployed package with
 * the same simple synchronous API, so it's the safer, more predictable
 * choice here.
 *
 * better-sqlite3 does NOT create the parent directory for the database
 * file automatically, and throws a raw, unfriendly TypeError if it's
 * missing -- which it always will be on a genuinely fresh checkout with
 * the default `DATABASE_PATH=./data/nuteco.db`. Creating the directory
 * first is the standard, expected behavior for "give me a database at
 * this path".
 */
export function openDatabase(filePath: string): Database.Database {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_identity (
      customer_id TEXT PRIMARY KEY,
      preferred_language TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      is_returning_customer INTEGER NOT NULL DEFAULT 0,
      is_b2b INTEGER NOT NULL DEFAULT 0,
      last_conversation_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      conversation_id TEXT PRIMARY KEY,
      current_intent TEXT,
      order_draft TEXT NOT NULL DEFAULT '{}',
      current_step TEXT,
      pending_clarification TEXT,
      escalation_flag INTEGER NOT NULL DEFAULT 0,
      variables TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}
