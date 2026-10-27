const crypto = require('crypto');
const { getDb } = require('../sqlite-client');

/**
 * Creates a new conversation thread.
 * @param {Object} params
 * @param {string} [params.id]
 * @param {string} [params.title]
 * @param {string} [params.reasoning_level]
 * @returns {Object} Created conversation record
 */
function createConversation({ id, title = 'New Conversation', reasoning_level = 'low' } = {}) {
  const db = getDb();
  const convId = id || crypto.randomUUID();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO conversations (id, title, rolling_summary, reasoning_level, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?)
  `);

  stmt.run(convId, title, reasoning_level, now, now);
  return getConversation(convId);
}

/**
 * Retrieves a single conversation by ID.
 * @param {string} id
 * @returns {Object|null}
 */
function getConversation(id) {
  if (!id) return null;
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM conversations WHERE id = ?');
  return stmt.get(id) || null;
}

/**
 * Retrieves all conversations ordered by updated_at descending.
 * @returns {Array<Object>}
 */
function getAllConversations() {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC');
  return stmt.all();
}

/**
 * Retrieves the most recently active conversation.
 * Crucial for seamless handoff when switching from Throw mode back to Save mode.
 * If no conversation exists, creates and returns a fresh one.
 * @returns {Object}
 */
function getMostRecentConversation() {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 1');
  const row = stmt.get();
  if (row) {
    return row;
  }
  return createConversation({ title: 'Workspace Conversation' });
}

/**
 * Updates properties of an existing conversation.
 * @param {string} id
 * @param {Object} updates
 * @returns {Object|null}
 */
function updateConversation(id, updates) {
  const db = getDb();
  const allowed = ['title', 'rolling_summary', 'reasoning_level'];
  const setClauses = [];
  const values = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      setClauses.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }

  if (setClauses.length === 0) {
    return getConversation(id);
  }

  setClauses.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  const sql = `UPDATE conversations SET ${setClauses.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);

  return getConversation(id);
}

/**
 * Updates the rolling summary of older conversation turns.
 * @param {string} id
 * @param {string} summary
 */
function updateRollingSummary(id, summary) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE conversations
    SET rolling_summary = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run(summary, Date.now(), id);
}

/**
 * Renames a conversation.
 * @param {string} id
 * @param {string} title
 * @returns {Object|null}
 */
function renameConversation(id, title) {
  return updateConversation(id, { title: String(title || 'Untitled Conversation').trim() });
}

/**
 * Updates the timestamp of a conversation to reflect recent activity.
 * @param {string} id
 */
function touchConversation(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Deletes a conversation by ID (foreign keys cascade to messages).
 * @param {string} id
 * @returns {boolean}
 */
function deleteConversation(id) {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM conversations WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

module.exports = {
  createConversation,
  getConversation,
  getAllConversations,
  getMostRecentConversation,
  updateConversation,
  updateRollingSummary,
  renameConversation,
  touchConversation,
  deleteConversation,
};
