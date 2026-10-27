const {
  getApiKeys,
  setApiKeys,
  getActiveKeyIndex,
  setActiveKeyIndex,
} = require('../database/repositories/settings-repo');
const { earconSynth } = require('../audio/earcon-synth');
const { ttsEngine } = require('../audio/tts-engine');

const COOLDOWN_DURATION_MS = 60000; // 60 seconds

class KeyPoolManager {
  constructor() {
    this.cooldowns = new Map(); // apiKey -> timestamp when cooldown ends
  }

  /**
   * Returns the list of registered API keys from the database.
   * @returns {string[]}
   */
  getKeys() {
    return getApiKeys();
  }

  /**
   * Sets the list of registered API keys.
   * @param {string[]} keys
   */
  setKeys(keys) {
    setApiKeys(keys);
  }

  /**
   * Adds a new API key to the pool.
   * @param {string} key
   */
  addKey(key) {
    const trimmed = String(key || '').trim();
    if (!trimmed) return;
    const current = this.getKeys();
    if (!current.includes(trimmed)) {
      current.push(trimmed);
      this.setKeys(current);
    }
  }

  /**
   * Removes an API key by value or index.
   * @param {string|number} identifier
   */
  removeKey(identifier) {
    const current = this.getKeys();
    let updated = [];
    if (typeof identifier === 'number') {
      updated = current.filter((_, idx) => idx !== identifier);
    } else {
      updated = current.filter((k) => k !== identifier);
    }
    this.setKeys(updated);
    this.cooldowns.delete(identifier);
  }

  /**
   * Cleans up expired cooldowns.
   */
  purgeExpiredCooldowns() {
    const now = Date.now();
    for (const [key, expiry] of this.cooldowns.entries()) {
      if (now >= expiry) {
        this.cooldowns.delete(key);
      }
    }
  }

  /**
   * Marks a specific API key as cooling down for the specified duration.
   * @param {string} key
   * @param {number} [durationMs=60000]
   */
  markCooldown(key, durationMs = COOLDOWN_DURATION_MS) {
    if (!key) return;
    this.cooldowns.set(key, Date.now() + durationMs);
  }

  /**
   * Returns real-time status of the API key pool.
   * @returns {{ total: number, ready: number, coolingDown: number, keys: Array<{ index: number, masked: string, status: 'READY'|'COOLDOWN', remainingSeconds: number }> }}
   */
  getStatus() {
    this.purgeExpiredCooldowns();
    const keys = this.getKeys();
    const now = Date.now();
    let readyCount = 0;
    let coolingCount = 0;

    const list = keys.map((k, index) => {
      const expiry = this.cooldowns.get(k) || 0;
      const isCooldown = now < expiry;
      const remaining = isCooldown ? Math.ceil((expiry - now) / 1000) : 0;

      if (isCooldown) {
        coolingCount++;
      } else {
        readyCount++;
      }

      // Mask key for UI display (e.g., "AIzaSy...4xQ1")
      const masked = k.length > 8 ? `${k.slice(0, 6)}...${k.slice(-4)}` : '********';

      return {
        index,
        masked,
        status: isCooldown ? 'COOLDOWN' : 'READY',
        remainingSeconds: remaining,
      };
    });

    return {
      total: keys.length,
      ready: readyCount,
      coolingDown: coolingCount,
      keys: list,
    };
  }

  /**
   * Obtains the next ready API key using round-robin rotation.
   * @returns {string|null}
   */
  getNextAvailableKey() {
    this.purgeExpiredCooldowns();
    const keys = this.getKeys();
    if (keys.length === 0) {
      return null;
    }

    const now = Date.now();
    const count = keys.length;
    let currentIndex = getActiveKeyIndex();

    for (let attempts = 0; attempts < count; attempts++) {
      const candidateIndex = (currentIndex + attempts) % count;
      const candidateKey = keys[candidateIndex];
      const expiry = this.cooldowns.get(candidateKey) || 0;

      if (now >= expiry) {
        // Advance round-robin pointer for next call
        const nextIndex = (candidateIndex + 1) % count;
        setActiveKeyIndex(nextIndex);
        return candidateKey;
      }
    }

    // All registered keys are currently cooling down
    return null;
  }

  /**
   * Checks if an error indicates rate-limiting, 429, or quota exhaustion.
   * @param {any} error
   * @returns {boolean}
   */
  isRateLimitError(error) {
    if (!error) return false;
    const msg = String(error.message || '').toLowerCase();
    const status = error.status || (error.response && error.response.status);

    return (
      status === 429 ||
      msg.includes('429') ||
      msg.includes('resource_exhausted') ||
      msg.includes('quota') ||
      msg.includes('rate limit') ||
      msg.includes('exhausted')
    );
  }

  /**
   * Triggers the all-keys-exhausted alert (3x Low Tut + verbal voice announcement).
   */
  async triggerAllKeysExhaustedAlert() {
    earconSynth.playTripleLowTut();
    await ttsEngine.speakRateLimitAlert();
  }

  /**
   * Executes an asynchronous AI task with round-robin key rotation and instant failover.
   * @template T
   * @param {(apiKey: string) => Promise<T>} taskFn
   * @returns {Promise<T>}
   */
  async executeWithRetry(taskFn) {
    const keys = this.getKeys();
    if (keys.length === 0) {
      throw new Error('No Google AI Studio API keys configured. Please add an API key in Settings.');
    }

    const maxAttempts = keys.length;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const apiKey = this.getNextAvailableKey();
      if (!apiKey) {
        // All keys are exhausted
        await this.triggerAllKeysExhaustedAlert();
        throw new Error('All API keys have reached their rate limit. Please wait a moment.');
      }

      try {
        const result = await taskFn(apiKey);
        return result;
      } catch (err) {
        lastError = err;
        if (this.isRateLimitError(err)) {
          this.markCooldown(apiKey, COOLDOWN_DURATION_MS);
          // Loop will immediately try next available key
          continue;
        } else {
          // If error is not a rate limit (e.g. invalid arguments), rethrow
          throw err;
        }
      }
    }

    // If loop finishes without returning
    await this.triggerAllKeysExhaustedAlert();
    throw (
      lastError ||
      new Error('All API keys have reached their rate limit. Please wait a moment.')
    );
  }
}

const keyPool = new KeyPoolManager();

module.exports = {
  keyPool,
  COOLDOWN_DURATION_MS,
};
