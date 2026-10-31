const path = require('path');
const { earconSynth } = require('../audio/earcon-synth');

// Load native Win32 low-level addon
let mouseSuppressor = null;
try {
  mouseSuppressor = require(path.join(__dirname, '../../../native-addons/build/Release/mouse_suppressor.node'));
} catch (_e1) {
  try {
    mouseSuppressor = require(path.join(__dirname, '../../../native-addons/build/Debug/mouse_suppressor.node'));
  } catch (_e2) {
    mouseSuppressor = {
      isForegroundWindowValid: () => false,
      sendUnicodeString: () => false,
      sendBackspace: () => false,
      isSynthesizingInput: () => false,
    };
  }
}

/**
 * Standard QWERTY keyboard adjacent keys map for typo generation.
 */
const QWERTY_ADJACENT = {
  q: ['w', 'a', 's'],
  w: ['q', 'e', 'a', 's', 'd'],
  e: ['w', 'r', 's', 'd', 'f'],
  r: ['e', 't', 'd', 'f', 'g'],
  t: ['r', 'y', 'f', 'g', 'h'],
  y: ['t', 'u', 'g', 'h', 'j'],
  u: ['y', 'i', 'h', 'j', 'k'],
  i: ['u', 'o', 'j', 'k', 'l'],
  o: ['i', 'p', 'k', 'l'],
  p: ['o', 'l'],
  a: ['q', 'w', 's', 'z'],
  s: ['a', 'd', 'w', 'e', 'z', 'x'],
  d: ['s', 'f', 'e', 'r', 'x', 'c'],
  f: ['d', 'g', 'r', 't', 'c', 'v'],
  g: ['f', 'h', 't', 'y', 'v', 'b'],
  h: ['g', 'j', 'y', 'u', 'b', 'n'],
  j: ['h', 'k', 'u', 'i', 'n', 'm'],
  k: ['j', 'l', 'i', 'o', 'm'],
  l: ['k', 'o', 'p'],
  z: ['a', 's', 'x'],
  x: ['z', 'c', 's', 'd'],
  c: ['x', 'v', 'd', 'f'],
  v: ['c', 'b', 'f', 'g'],
  b: ['v', 'n', 'g', 'h'],
  n: ['b', 'm', 'h', 'j'],
  m: ['n', 'j', 'k'],
  '1': ['2', 'q'],
  '2': ['1', '3', 'w', 'q'],
  '3': ['2', '4', 'e', 'w'],
  '4': ['3', '5', 'r', 'e'],
  '5': ['4', '6', 't', 'r'],
  '6': ['5', '7', 'y', 't'],
  '7': ['6', '8', 'u', 'y'],
  '8': ['7', '9', 'i', 'u'],
  '9': ['8', '0', 'o', 'i'],
  '0': ['9', 'p', 'o'],
};

class AutoTyper {
  constructor() {
    this.isActive = false;
    this.isSuspended = false;
    this.isInjecting = false;
    this.cancelRequested = false;

    this.currentText = '';
    this.currentIndex = 0;

    this.inactivityTimer = null;
    this.suspendResolve = null;
  }

  /**
   * Performs pre-flight safety check to ensure a valid application window has focus.
   * @returns {boolean}
   */
  isForegroundWindowValid() {
    try {
      if (mouseSuppressor && typeof mouseSuppressor.isForegroundWindowValid === 'function') {
        return mouseSuppressor.isForegroundWindowValid();
      }
    } catch (_err) {
      // Fallback
    }
    return false;
  }

  /**
   * Starts or resumes human-like auto-typing simulation from character index 0.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async start(text) {
    if (this.isActive) {
      return false;
    }

    // 4.1 Pre-Flight Safety Check: Win32 GetForegroundWindow
    if (!this.isForegroundWindowValid()) {
      earconSynth.playDoubleLowTut(); // 2x low tut (440 Hz, 110 ms)
      return false;
    }

    const cleanText = String(text || '').trim();
    if (!cleanText) {
      earconSynth.playDoubleLowTut();
      return false;
    }

    this.isActive = true;
    this.isSuspended = false;
    this.cancelRequested = false;
    this.currentIndex = 0;
    this.currentText = cleanText;

    // Auditory feedback: 1x Long Tut (880 Hz, 350ms) on start typing
    earconSynth.playLongTut();

    // Run typing cadence loop asynchronously
    this._runLoop().catch((_err) => {
      this.abort();
    });

    return true;
  }

  /**
   * Immediately aborts and silences any active auto-typing operation without playing error tones.
   */
  abort() {
    this.cancelRequested = true;
    this.isActive = false;
    this.isSuspended = false;

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.suspendResolve) {
      this.suspendResolve();
      this.suspendResolve = null;
    }
  }

  /**
   * Toggles auto-typing: if active, aborts and plays 2x low tut. If idle, starts from index 0.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async toggle(text) {
    if (this.isActive) {
      this.abort();
      earconSynth.playDoubleLowTut(); // 2x low tut (440 Hz) on cancel
      return false;
    }
    return this.start(text);
  }

  /**
   * Concurrency Arbitration: Called when user presses any physical keyboard key.
   * Immediately suspends auto-typing and arms a 5-second inactivity timer.
   */
  onPhysicalKeyPress() {
    if (!this.isActive || this.isInjecting) {
      return;
    }

    this.isSuspended = true;

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      this.isSuspended = false;
      this.inactivityTimer = null;
      if (this.suspendResolve) {
        this.suspendResolve();
        this.suspendResolve = null;
      }
    }, 5000);
  }

  /**
   * Main typing cadence and typo simulation loop.
   */
  async _runLoop() {
    const text = this.currentText;
    let wpm = Math.floor(Math.random() * 36) + 85; // WPM in [85, 120]
    let wordCount = 0;
    let pauseThreshold = Math.floor(Math.random() * 3) + 3; // K in [3, 5]

    let inWord = false;
    let wordTypoTargetIndex = -1;

    // Small pause to allow start earcon (350ms long tut) to ring clearly
    await this._sleep(350);

    while (this.currentIndex < text.length && !this.cancelRequested) {
      // 1. Suspension handler: wait until 5s of user inactivity elapse
      while (this.isSuspended && !this.cancelRequested) {
        await new Promise((resolve) => {
          this.suspendResolve = resolve;
        });
      }
      if (this.cancelRequested) break;

      const char = text[this.currentIndex];
      const isAlphanumeric = /[a-zA-Z0-9]/.test(char);

      // 2. Word Tracking & Dynamic Typo Subsystem per word (3% at 85 WPM up to 8% at 120 WPM)
      if (!inWord && isAlphanumeric) {
        inWord = true;
        // Typo probability scales linearly with current word's WPM: 3% at 85 WPM to 8% at 120 WPM
        const clampedWpm = Math.max(85, Math.min(120, wpm));
        const typoRate = 0.03 + ((clampedWpm - 85) / 35) * 0.05;
        const willTypo = Math.random() < typoRate;
        if (willTypo) {
          const wordMatch = text.slice(this.currentIndex).match(/^[a-zA-Z0-9]+/);
          const wordLen = wordMatch ? wordMatch[0].length : 1;
          wordTypoTargetIndex = this.currentIndex + Math.floor(Math.random() * wordLen);
        } else {
          wordTypoTargetIndex = -1;
        }
      } else if (!isAlphanumeric) {
        inWord = false;
        wordTypoTargetIndex = -1;
      }

      const shouldTypo = !this.isSuspended && isAlphanumeric && (this.currentIndex === wordTypoTargetIndex);

      if (shouldTypo) {
        wordTypoTargetIndex = -1; // Consume typo for this word
        const wrongChar = this._getAdjacentChar(char);
        await this._injectChar(wrongChar);

        // Forward type next M characters (M in [1, 3])
        const remainingCount = text.length - (this.currentIndex + 1);
        const m = Math.min(remainingCount, Math.floor(Math.random() * 3) + 1);
        const forwardChars = text.slice(this.currentIndex + 1, this.currentIndex + 1 + m);

        for (let j = 0; j < forwardChars.length; j++) {
          if (this.cancelRequested || this.isSuspended) break;
          const delay = this._calculateCharDelay(wpm);
          await this._sleep(delay);
          await this._injectChar(forwardChars[j]);
        }

        // Reaction pause: Sleep 150ms - 250ms
        if (!this.cancelRequested && !this.isSuspended) {
          const reactionPause = Math.floor(Math.random() * 101) + 150;
          await this._sleep(reactionPause);
        }

        // Send M + 1 virtual Backspaces with fixed 100ms delay between each
        const backspacesToSend = forwardChars.length + 1;
        for (let b = 0; b < backspacesToSend; b++) {
          if (this.cancelRequested || this.isSuspended) break;
          await this._injectBackspace();
          await this._sleep(100);
        }

        // Re-type correct character and forward characters
        if (!this.cancelRequested && !this.isSuspended) {
          await this._injectChar(char);
          for (let j = 0; j < forwardChars.length; j++) {
            if (this.cancelRequested || this.isSuspended) break;
            const delay = this._calculateCharDelay(wpm);
            await this._sleep(delay);
            await this._injectChar(forwardChars[j]);
          }
        }

        this.currentIndex += (1 + forwardChars.length);
      } else {
        // Normal character injection
        await this._injectChar(char);
        this.currentIndex++;
      }

      if (this.cancelRequested) break;

      // 3. Word boundary check: Natural Hesitation / Pauses
      if (char === ' ' || char === '\n') {
        wordCount++;
        wpm = Math.floor(Math.random() * 36) + 85; // Roll new WPM in [85, 120]

        if (wordCount >= pauseThreshold) {
          // Thinking pause: sleep T_pause in [3000ms, 10000ms]
          const pauseDuration = Math.floor(Math.random() * 7001) + 3000;
          await this._sleep(pauseDuration);
          wordCount = 0;
          pauseThreshold = Math.floor(Math.random() * 3) + 6; // Roll new K in [3, 8]
        }
      }

      // 4. Per-character base delay with jitter
      const charDelay = this._calculateCharDelay(wpm);
      await this._sleep(charDelay);
    }

    const completedNaturally = !this.cancelRequested && this.currentIndex >= text.length;

    this.isActive = false;
    this.isSuspended = false;

    // Auditory feedback: 2x Rapid Short Tut (880 Hz, 90ms) when typing finishes naturally
    if (completedNaturally) {
      earconSynth.playDoubleShortTut();
    }
  }

  /**
   * Calculates character delay in ms based on WPM target and random jitter.
   * @param {number} wpm
   * @returns {number}
   */
  _calculateCharDelay(wpm) {
    const base = 60000 / (wpm * 5);
    const jitter = Math.floor(Math.random() * 31) - 15; // [-15ms, +15ms]
    return Math.max(25, Math.round(base + jitter));
  }

  /**
   * Picks a neighboring QWERTY character for typo simulation, matching casing.
   * @param {string} char
   * @returns {string}
   */
  _getAdjacentChar(char) {
    const lower = char.toLowerCase();
    const adjacentList = QWERTY_ADJACENT[lower] || ['s'];
    const picked = adjacentList[Math.floor(Math.random() * adjacentList.length)];
    return char === char.toUpperCase() ? picked.toUpperCase() : picked;
  }

  /**
   * Injects a unicode character via Win32 SendInput.
   * @param {string} ch
   */
  async _injectChar(ch) {
    this.isInjecting = true;
    try {
      if (mouseSuppressor && typeof mouseSuppressor.sendUnicodeString === 'function') {
        mouseSuppressor.sendUnicodeString(ch);
      }
    } finally {
      // Tiny tick so uiohook ignores the synthetic event
      await new Promise((r) => setTimeout(r, 6));
      this.isInjecting = false;
    }
  }

  /**
   * Injects virtual Backspace key via Win32 SendInput.
   */
  async _injectBackspace() {
    this.isInjecting = true;
    try {
      if (mouseSuppressor && typeof mouseSuppressor.sendBackspace === 'function') {
        mouseSuppressor.sendBackspace();
      }
    } finally {
      await new Promise((r) => setTimeout(r, 6));
      this.isInjecting = false;
    }
  }

  /**
   * Responsive sleep helper that wakes up immediately if cancellation is requested.
   * @param {number} ms
   */
  async _sleep(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.cancelRequested) break;
      const remaining = ms - (Date.now() - start);
      await new Promise((r) => setTimeout(r, Math.min(remaining, 50)));
    }
  }
}

const autoTyper = new AutoTyper();

module.exports = {
  autoTyper,
  AutoTyper,
};
