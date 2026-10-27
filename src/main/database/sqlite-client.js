const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let dbInstance = null;

/**
 * Resolves the database storage directory path.
 * Uses Electron app.getPath('userData') if available, otherwise defaults to local directory.
 * @returns {string} Directory path for omniscience.db
 */
function resolveDbDirectory() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch (_err) {
    // Electron app not yet ready or running outside Electron process
  }
  const fallbackDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(fallbackDir)) {
    fs.mkdirSync(fallbackDir, { recursive: true });
  }
  return fallbackDir;
}

/**
 * Initializes the SQLite database, configures pragmas, and runs idempotent schema migrations.
 * @param {string} [customPath] - Optional custom path for the database file.
 * @returns {import('better-sqlite3').Database}
 */
function initDatabase(customPath) {
  if (dbInstance) {
    return dbInstance;
  }

  const dbDir = customPath ? path.dirname(customPath) : resolveDbDirectory();
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbFilePath = customPath || path.join(dbDir, 'omniscience.db');
  dbInstance = new Database(dbFilePath);

  // Performance and integrity pragmas
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('foreign_keys = ON');

  // Idempotent table schemas
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rolling_summary TEXT,
      reasoning_level TEXT DEFAULT 'low',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT,
      extracted_image_context TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
  `);

  return dbInstance;
}

/**
 * Retrieves the active SQLite database instance.
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Closes the SQLite database connection cleanly.
 */
function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_err) {
      // Ignored if already closed
    }
    dbInstance = null;
  }
}

module.exports = {
  initDatabase,
  getDb,
  closeDb,
  resolveDbDirectory,
};
