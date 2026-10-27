const { getDb } = require('../sqlite-client');

const DEFAULT_SETTINGS = {
  api_keys: [],
  active_key_index: 0,
  active_model: 'gemini-3.8-flash',
  audio_output_device_id: 'default',
  earcon_volume: 0.8,
  tts_volume: 1.0,
  companion_sub_mode: 'save',
  reasoning_level: 'low',
  companion_armed: false,
};

/**
 * Retrieves a raw setting string value by key.
 * @param {string} key
 * @returns {string|null}
 */
function getRawSetting(key) {
  const db = getDb();
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get(key);
  return row ? row.value : null;
}

/**
 * Sets or updates a raw setting string value.
 * @param {string} key
 * @param {string} value
 */
function setRawSetting(key, value) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, value);
}

/**
 * Retrieves parsed setting value, or returns fallback.
 * @param {string} key
 * @param {*} defaultValue
 * @returns {*}
 */
function getSetting(key, defaultValue = undefined) {
  const raw = getRawSetting(key);
  if (raw === null) {
    return defaultValue !== undefined ? defaultValue : DEFAULT_SETTINGS[key];
  }
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return raw;
  }
}

/**
 * Sets parsed setting value as JSON string.
 * @param {string} key
 * @param {*} value
 */
function setSetting(key, value) {
  const str = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  setRawSetting(key, str);
}

/**
 * Retrieves all configuration settings as an object.
 * @returns {typeof DEFAULT_SETTINGS}
 */
function getAllSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch (_e) {
      result[row.key] = row.value;
    }
  }

  return result;
}

/**
 * Updates multiple settings in a single transaction.
 * @param {Partial<typeof DEFAULT_SETTINGS>} updates
 * @returns {typeof DEFAULT_SETTINGS}
 */
function updateSettings(updates) {
  const db = getDb();
  const setMany = db.transaction((entries) => {
    const stmt = db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [k, v] of entries) {
      stmt.run(k, JSON.stringify(v));
    }
  });

  setMany(Object.entries(updates));
  return getAllSettings();
}

/**
 * Convenience getter for registered API keys.
 * @returns {string[]}
 */
function getApiKeys() {
  const keys = getSetting('api_keys', []);
  return Array.isArray(keys) ? keys : [];
}

/**
 * Convenience setter for registered API keys.
 * @param {string[]} keys
 */
function setApiKeys(keys) {
  const valid = Array.isArray(keys) ? keys.map((k) => String(k).trim()).filter(Boolean) : [];
  setSetting('api_keys', valid);
}

/**
 * Convenience getter for active key index.
 * @returns {number}
 */
function getActiveKeyIndex() {
  const idx = Number(getSetting('active_key_index', 0));
  return Number.isInteger(idx) && idx >= 0 ? idx : 0;
}

/**
 * Convenience setter for active key index.
 * @param {number} index
 */
function setActiveKeyIndex(index) {
  setSetting('active_key_index', Math.max(0, parseInt(index, 10) || 0));
}

/**
 * Convenience getter for selected audio output device ID.
 * @returns {string}
 */
function getAudioDeviceId() {
  return String(getSetting('audio_output_device_id', 'default'));
}

/**
 * Convenience setter for selected audio output device ID.
 * @param {string} deviceId
 */
function setAudioDeviceId(deviceId) {
  setSetting('audio_output_device_id', String(deviceId || 'default'));
}

/**
 * Convenience getter for volumes.
 * @returns {{ earconVolume: number, ttsVolume: number }}
 */
function getVolumes() {
  const earconVolume = Number(getSetting('earcon_volume', 0.8));
  const ttsVolume = Number(getSetting('tts_volume', 1.0));
  return {
    earconVolume: isNaN(earconVolume) ? 0.8 : Math.max(0, Math.min(1, earconVolume)),
    ttsVolume: isNaN(ttsVolume) ? 1.0 : Math.max(0, Math.min(1, ttsVolume)),
  };
}

/**
 * Convenience setter for volumes.
 * @param {{ earconVolume?: number, ttsVolume?: number }} volumes
 */
function setVolumes({ earconVolume, ttsVolume }) {
  const updates = {};
  if (earconVolume !== undefined) {
    updates.earcon_volume = Math.max(0, Math.min(1, Number(earconVolume)));
  }
  if (ttsVolume !== undefined) {
    updates.tts_volume = Math.max(0, Math.min(1, Number(ttsVolume)));
  }
  updateSettings(updates);
}

/**
 * Convenience getter for active model identifier.
 * @returns {string}
 */
function getActiveModel() {
  return String(getSetting('active_model', 'gemini-3.8-flash'));
}

/**
 * Convenience setter for active model identifier.
 * @param {string} model
 */
function setActiveModel(model) {
  setSetting('active_model', String(model || 'gemini-3.8-flash'));
}

module.exports = {
  DEFAULT_SETTINGS,
  getSetting,
  setSetting,
  getAllSettings,
  updateSettings,
  getApiKeys,
  setApiKeys,
  getActiveKeyIndex,
  setActiveKeyIndex,
  getActiveModel,
  setActiveModel,
  getAudioDeviceId,
  setAudioDeviceId,
  getVolumes,
  setVolumes,
};
