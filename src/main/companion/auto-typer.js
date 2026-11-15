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
      releaseModifiers: () => false,
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

class AbortTypingSignal extends Error {
  constructor() {
    super('Auto-typing aborted');
    this.name = 'AbortTypingSignal';
  }
}

class AutoTyper {
  constructor() {
    this.state = 'IDLE'; // 'IDLE' | 'RUNNING' | 'PAUSED'
    this.fullText = '';
    this.currentIndex = 0;
    this.isManuallyPaused = false;
    this.isUserTypingPaused = false;
    this.isInjecting = false;
    this.pendingTypo = null;

    this.runGeneration = 0;
    this.inactivityTimer = null;
  }

  /**
   * Returns current auto-typer state ('IDLE' | 'RUNNING' | 'PAUSED').
   * @returns {'IDLE'|'RUNNING'|'PAUSED'}
   */
  getState() {
    return this.state;
  }

  /**
   * Backward-compatible indicator for whether auto-typer is RUNNING or PAUSED.
   * @returns {boolean}
   */
  get isActive() {
    return this.state === 'RUNNING' || this.state === 'PAUSED';
  }

  /**
   * Backward-compatible alias for fullText.
   * @returns {string}
   */
  get currentText() {
    return this.fullText;
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
   * Dispatches Win32 KEYEVENTF_KEYUP for all modifier keys and waits delayMs before typing.
   * @param {number} [delayMs=60]
   * @param {number} [gen=this.runGeneration]
   */
  async _flushModifiersAndSettle(delayMs = 60, gen = this.runGeneration) {
    if (mouseSuppressor && typeof mouseSuppressor.releaseModifiers === 'function') {
      mouseSuppressor.releaseModifiers();
    }
    await new Promise((r) => setTimeout(r, delayMs));
    if (this.state === 'IDLE' || gen !== this.runGeneration) {
      throw new AbortTypingSignal();
    }
  }

  /**
   * Starts human-like auto-typing simulation from character index 0.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async start(text) {
    if (this.state !== 'IDLE') {
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

    const gen = ++this.runGeneration;
    this.state = 'RUNNING';
    this.fullText = cleanText;
    this.currentIndex = 0;
    this.isManuallyPaused = false;
    this.isUserTypingPaused = false;
    this.pendingTypo = null;

    // Auditory feedback: 1x Long Tut (880 Hz, 350ms) on start typing
    earconSynth.playLongTut();

    // Run typing cadence loop asynchronously
    this._runLoop(gen).catch((err) => {
      if (!(err instanceof AbortTypingSignal) && this.runGeneration === gen) {
        this.abort();
      }
    });

    return true;
  }

  /**
   * Immediately pauses execution at the exact currentIndex without losing progress.
   * @returns {boolean}
   */
  pause() {
    if (this.state !== 'RUNNING') {
      return false;
    }
    this.state = 'PAUSED';
    this.isManuallyPaused = true;
    return true;
  }

  /**
   * Resumes execution from PAUSED state after releasing modifier keys and waiting 60ms.
   * @returns {Promise<boolean>}
   */
  async resume() {
    if (this.state !== 'PAUSED') {
      return false;
    }

    const gen = this.runGeneration;
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.isUserTypingPaused = false;

    try {
      await this._flushModifiersAndSettle(60, gen);
    } catch (err) {
      if (err instanceof AbortTypingSignal) {
        return false;
      }
      throw err;
    }

    if (this.state !== 'PAUSED' || this.runGeneration !== gen) {
      return false;
    }

    this.isManuallyPaused = false;
    this.state = 'RUNNING';
    return true;
  }

  /**
   * Immediately aborts and resets any active or paused auto-typing operation to IDLE.
   */
  abort() {
    this.runGeneration++;
    this.state = 'IDLE';
    this.isManuallyPaused = false;
    this.isUserTypingPaused = false;
    this.currentIndex = 0;
    this.fullText = '';
    this.pendingTypo = null;

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  /**
   * Toggles auto-typing: if active/paused, aborts and plays 2x low tut. If idle, starts from index 0.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async toggle(text) {
    if (this.state !== 'IDLE') {
      this.abort();
      earconSynth.playDoubleLowTut(); // 2x low tut (440 Hz) on cancel
      return false;
    }
    return this.start(text);
  }

  /**
   * Concurrency Arbitration: Called when user presses any physical keyboard key.
   * Immediately suspends auto-typing and arms a 5-second inactivity timer.
   * Never overrides or auto-resumes a manual pause.
   */
  onPhysicalKeyPress() {
    if (this.state === 'IDLE' || this.isInjecting || this.isManuallyPaused) {
      return;
    }

    this.isUserTypingPaused = true;
    this.state = 'PAUSED';

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      this.inactivityTimer = null;
      this.isUserTypingPaused = false;
      if (this.state === 'PAUSED' && !this.isManuallyPaused) {
        this.state = 'RUNNING';
      }
    }, 5000);
  }

  /**
   * Granular gatekeeper checked before every character injection, backspace, and sleep slice.
   * Polls non-blockingly at 20ms while paused and throws AbortTypingSignal if aborted.
   * @param {number} [gen=this.runGeneration]
   */
  async waitUntilRunnable(gen = this.runGeneration) {
    while (true) {
      if (this.state === 'IDLE' || gen !== this.runGeneration) {
        throw new AbortTypingSignal();
      }
      if (!this.isManuallyPaused && !this.isUserTypingPaused && this.state === 'RUNNING') {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Main typing cadence and typo simulation loop.
   * @param {number} gen
   */
  async _runLoop(gen) {
    const text = this.fullText;
    let wpm = Math.floor(Math.random() * 36) + 85; // WPM in [85, 120]
    let wordCount = 0;
    let pauseThreshold = Math.floor(Math.random() * 3) + 3; // K in [3, 5]

    let inWord = false;
    let wordTypoTargetIndex = -1;

    // Small pause to allow start earcon (350ms long tut) to ring clearly
    await this._sleep(350, gen);

    // Flush held hotkey modifier keys right before typing and allow 60ms settle
    await this._flushModifiersAndSettle(60, gen);

    while (this.currentIndex < text.length) {
      await this.waitUntilRunnable(gen);

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

      const shouldTypo = isAlphanumeric && (this.currentIndex === wordTypoTargetIndex);

      if (shouldTypo) {
        wordTypoTargetIndex = -1; // Consume typo for this word
        const wrongChar = this._getAdjacentChar(char);

        // Forward type next M characters (M in [1, 3])
        const remainingCount = text.length - (this.currentIndex + 1);
        const m = Math.min(remainingCount, Math.floor(Math.random() * 3) + 1);
        const forwardChars = text.slice(this.currentIndex + 1, this.currentIndex + 1 + m);

        // Track active typo sequence so pauses mid-typo resume seamlessly from exact sub-step
        this.pendingTypo = {
          baseIndex: this.currentIndex,
          wrongChar,
          correctChar: char,
          forwardChars,
        };

        await this.waitUntilRunnable(gen);
        await this._injectChar(wrongChar);

        for (let j = 0; j < forwardChars.length; j++) {
          const delay = this._calculateCharDelay(wpm);
          await this._sleep(delay, gen);
          await this.waitUntilRunnable(gen);
          await this._injectChar(forwardChars[j]);
        }

        // Reaction pause: Sleep 150ms - 250ms
        const reactionPause = Math.floor(Math.random() * 101) + 150;
        await this._sleep(reactionPause, gen);

        // Send M + 1 virtual Backspaces with fixed 100ms delay between each
        const backspacesToSend = forwardChars.length + 1;
        for (let b = 0; b < backspacesToSend; b++) {
          await this.waitUntilRunnable(gen);
          await this._injectBackspace();
          await this._sleep(100, gen);
        }

        // Re-type correct character and forward characters
        await this.waitUntilRunnable(gen);
        await this._injectChar(char);
        for (let j = 0; j < forwardChars.length; j++) {
          const delay = this._calculateCharDelay(wpm);
          await this._sleep(delay, gen);
          await this.waitUntilRunnable(gen);
          await this._injectChar(forwardChars[j]);
        }

        this.currentIndex += (1 + forwardChars.length);
        this.pendingTypo = null;
      } else {
        // Normal character injection
        await this.waitUntilRunnable(gen);
        await this._injectChar(char);
        this.currentIndex++;
      }

      // 3. Word boundary check: Natural Hesitation / Pauses
      if (char === ' ' || char === '\n') {
        wordCount++;
        wpm = Math.floor(Math.random() * 36) + 85; // Roll new WPM in [85, 120]

        if (wordCount >= pauseThreshold) {
          // Thinking pause: sleep T_pause in [3000ms, 10000ms]
          const pauseDuration = Math.floor(Math.random() * 7001) + 3000;
          await this._sleep(pauseDuration, gen);
          wordCount = 0;
          pauseThreshold = Math.floor(Math.random() * 3) + 3; // Roll new K in [3, 5]
        }
      }

      // 4. Per-character base delay with jitter
      const charDelay = this._calculateCharDelay(wpm);
      await this._sleep(charDelay, gen);
    }

    if (gen !== this.runGeneration || this.state === 'IDLE') {
      return;
    }

    this.state = 'IDLE';
    this.isManuallyPaused = false;
    this.isUserTypingPaused = false;
    this.currentIndex = 0;
    this.fullText = '';
    this.pendingTypo = null;

    // Auditory feedback: 2x Rapid Short Tut (880 Hz, 90ms) when typing finishes naturally
    earconSynth.playDoubleShortTut();
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
   * Responsive sleep helper that respects PAUSED states without advancing sleep time
   * and aborts immediately when state transitions to IDLE.
   * @param {number} ms
   * @param {number} [gen=this.runGeneration]
   */
  async _sleep(ms, gen = this.runGeneration) {
    let elapsedActive = 0;
    while (elapsedActive < ms) {
      await this.waitUntilRunnable(gen);
      const remaining = ms - elapsedActive;
      const slice = Math.min(remaining, 20);
      const tickStart = Date.now();
      await new Promise((r) => setTimeout(r, slice));
      elapsedActive += Math.max(slice, Date.now() - tickStart);
    }
  }
}

const autoTyper = new AutoTyper();

module.exports = {
  autoTyper,
  AutoTyper,
  AbortTypingSignal,
};
