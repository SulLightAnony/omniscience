const crypto = require('crypto');
const { getDb } = require('../sqlite-client');
const {
  touchConversation,
  getConversation,
  getMostRecentConversation,
} = require('./conversation-repo');

/**
 * Inserts a new message into a conversation thread.
 * @param {Object} params
 * @param {string} [params.id]
 * @param {string} params.conversation_id
 * @param {'user'|'model'} params.role
 * @param {string} params.content
 * @param {string|Array<string>} [params.attachments_json]
 * @param {string} [params.extracted_image_context]
 * @param {number} [params.created_at]
 * @returns {Object} Inserted message record
 */
function addMessage({
  id,
  conversation_id,
  role,
  content,
  attachments_json = null,
  extracted_image_context = null,
  created_at = null,
}) {
  const db = getDb();
  const messageId = id || crypto.randomUUID();
  const timestamp = created_at || Date.now();

  // Validate that conversation exists to prevent FOREIGN KEY constraint failures
  let targetConversationId = conversation_id;
  const existing = targetConversationId ? getConversation(targetConversationId) : null;
  if (!existing) {
    const fallbackConv = getMostRecentConversation();
    targetConversationId = fallbackConv.id;
  }

  let attachmentsStr = null;
  if (Array.isArray(attachments_json)) {
    attachmentsStr = JSON.stringify(attachments_json);
  } else if (typeof attachments_json === 'string') {
    attachmentsStr = attachments_json;
  }

  const stmt = db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, content, attachments_json, extracted_image_context, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    messageId,
    targetConversationId,
    role,
    content || '',
    attachmentsStr,
    extracted_image_context,
    timestamp
  );

  touchConversation(targetConversationId);
  return getMessageById(messageId);
}

/**
 * Retrieves a single message by ID.
 * @param {string} id
 * @returns {Object|null}
 */
function getMessageById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!row) return null;

  return parseMessageRow(row);
}

/**
 * Retrieves all messages for a given conversation ordered chronologically.
 * @param {string} conversationId
 * @returns {Array<Object>}
 */
function getMessages(conversationId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(conversationId);

  return rows.map(parseMessageRow);
}

/**
 * Retrieves the most recent messages for a conversation up to a given limit.
 * @param {string} conversationId
 * @param {number} limit
 * @returns {Array<Object>} In ascending chronological order
 */
function getRecentMessages(conversationId, limit = 16) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
    ORDER BY created_at ASC
  `).all(conversationId, limit);

  return rows.map(parseMessageRow);
}

/**
 * Updates the extracted image context summary for historical turn pruning.
 * @param {string} messageId
 * @param {string} contextText
 */
function updateExtractedImageContext(messageId, contextText) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE messages
    SET extracted_image_context = ?
    WHERE id = ?
  `);
  stmt.run(contextText, messageId);
}

/**
 * Counts total messages in a conversation.
 * @param {string} conversationId
 * @returns {number}
 */
function getMessageCount(conversationId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?
  `).get(conversationId);
  return row ? row.count : 0;
}

/**
 * Deletes a single message by ID.
 * @param {string} id
 * @returns {boolean}
 */
function deleteMessage(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Helper to safely parse attachments_json.
 * @param {Object} row
 * @returns {Object}
 */
function parseMessageRow(row) {
  let parsedAttachments = [];
  if (row.attachments_json) {
    try {
      parsedAttachments = JSON.parse(row.attachments_json);
    } catch (_e) {
      parsedAttachments = [];
    }
  }
  return {
    ...row,
    attachments: parsedAttachments,
  };
}

module.exports = {
  addMessage,
  getMessageById,
  getMessages,
  getRecentMessages,
  updateExtractedImageContext,
  getMessageCount,
  deleteMessage,
};
