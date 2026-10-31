const path = require('path');
const { clipboard } = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { stateMachine } = require('./state-machine');
const { stagingBuffer } = require('./staging-buffer');
const { screenCapture } = require('./screen-capture');
const { autoTyper } = require('./auto-typer');
const { companionCache } = require('./companion-cache');
const { audioSession } = require('../audio/audio-session');
const { earconSynth } = require('../audio/earcon-synth');
const { ttsEngine } = require('../audio/tts-engine');
const { geminiService } = require('../ai/gemini-service');
const { transcribeAudio } = require('../ai/stt-service');
const { getActiveModel, setActiveModel } = require('../database/repositories/settings-repo');

// Load native Win32 low-level mouse hook addon
let mouseSuppressor = null;
try {
  mouseSuppressor = require(path.join(__dirname, '../../../native-addons/build/Release/mouse_suppressor.node'));
} catch (_e1) {
  try {
    mouseSuppressor = require(path.join(__dirname, '../../../native-addons/build/Debug/mouse_suppressor.node'));
  } catch (_e2) {
    mouseSuppressor = {
      enableSuppression: () => false,
      disableSuppression: () => false,
      isSuppressionArmed: () => false,
      installHook: () => false,
      uninstallHook: () => false,
    };
  }
}

const KEY_TO_CHAR_LETTERS = {
  [UiohookKey.A]: 'a',
  [UiohookKey.B]: 'b',
  [UiohookKey.C]: 'c',
  [UiohookKey.D]: 'd',
  [UiohookKey.E]: 'e',
  [UiohookKey.F]: 'f',
  [UiohookKey.G]: 'g',
  [UiohookKey.H]: 'h',
  [UiohookKey.I]: 'i',
  [UiohookKey.J]: 'j',
  [UiohookKey.K]: 'k',
  [UiohookKey.L]: 'l',
  [UiohookKey.M]: 'm',
  [UiohookKey.N]: 'n',
  [UiohookKey.O]: 'o',
  [UiohookKey.P]: 'p',
  [UiohookKey.Q]: 'q',
  [UiohookKey.R]: 'r',
  [UiohookKey.S]: 's',
  [UiohookKey.T]: 't',
  [UiohookKey.U]: 'u',
  [UiohookKey.V]: 'v',
  [UiohookKey.W]: 'w',
  [UiohookKey.X]: 'x',
  [UiohookKey.Y]: 'y',
  [UiohookKey.Z]: 'z',
};

const KEY_TO_CHAR_NUMBERS = {
  [UiohookKey['0']]: { normal: '0', shift: ')' },
  [UiohookKey['1']]: { normal: '1', shift: '!' },
  [UiohookKey['2']]: { normal: '2', shift: '@' },
  [UiohookKey['3']]: { normal: '3', shift: '#' },
  [UiohookKey['4']]: { normal: '4', shift: '$' },
  [UiohookKey['5']]: { normal: '5', shift: '%' },
  [UiohookKey['6']]: { normal: '6', shift: '^' },
  [UiohookKey['7']]: { normal: '7', shift: '&' },
  [UiohookKey['8']]: { normal: '8', shift: '*' },
  [UiohookKey['9']]: { normal: '9', shift: '(' },
  [UiohookKey.Numpad0]: { normal: '0', shift: '0' },
  [UiohookKey.Numpad1]: { normal: '1', shift: '1' },
  [UiohookKey.Numpad2]: { normal: '2', shift: '2' },
  [UiohookKey.Numpad3]: { normal: '3', shift: '3' },
  [UiohookKey.Numpad4]: { normal: '4', shift: '4' },
  [UiohookKey.Numpad5]: { normal: '5', shift: '5' },
  [UiohookKey.Numpad6]: { normal: '6', shift: '6' },
  [UiohookKey.Numpad7]: { normal: '7', shift: '7' },
  [UiohookKey.Numpad8]: { normal: '8', shift: '8' },
  [UiohookKey.Numpad9]: { normal: '9', shift: '9' },
};

const KEY_TO_CHAR_SYMBOLS = {
  [UiohookKey.Minus]: { normal: '-', shift: '_' },
  [UiohookKey.Equal]: { normal: '=', shift: '+' },
  [UiohookKey.BracketLeft]: { normal: '[', shift: '{' },
  [UiohookKey.BracketRight]: { normal: ']', shift: '}' },
  [UiohookKey.Backslash]: { normal: '\\', shift: '|' },
  [UiohookKey.Semicolon]: { normal: ';', shift: ':' },
  [UiohookKey.Quote]: { normal: "'", shift: '"' },
  [UiohookKey.Comma]: { normal: ',', shift: '<' },
  [UiohookKey.Period]: { normal: '.', shift: '>' },
  [UiohookKey.Slash]: { normal: '/', shift: '?' },
  [UiohookKey.Backquote]: { normal: '`', shift: '~' },
  [UiohookKey.NumpadDecimal]: { normal: '.', shift: '.' },
  [UiohookKey.NumpadDivide]: { normal: '/', shift: '/' },
  [UiohookKey.NumpadMultiply]: { normal: '*', shift: '*' },
  [UiohookKey.NumpadSubtract]: { normal: '-', shift: '-' },
  [UiohookKey.NumpadAdd]: { normal: '+', shift: '+' },
};

class HookManager {
  constructor() {
    this.isListening = false;
    this.audioRecordingHandler = null; // Callback: (action: 'start'|'stop') => Promise<Buffer>
    this.modelChangeDispatcher = null; // Callback: (newModel: string) => void
    this.outputProfileChangeDispatcher = null; // Callback: (newProfile: string) => void

    // Keyboard state
    this.keysDown = new Set();
    this.currentMouse = { x: 0, y: 0 };
    this.isCapsLockActive = false;

    // Timers & tracking states
    this.regionHoldTimer = null;
    this.isRegionTimerArmed = false;

    this.mouseButtonsDown = new Set();
    this.voiceHoldTimer = null;
    this.isVoiceRecording = false;

    this.arrowUpPressTime = 0;
    this.arrowUpHoldTimer = null;
    this.arrowUpHoldTriggered = false;

    this.lastRAltDownTime = 0;
    this.lastRAltUpTime = 0;
    this.rAltHoldTimer = null;
    this.rAltHoldTriggered = false;
    this.rAltSingleTapTimer = null;
    this.isRAltDoubleTap = false;
    this.isRAltActiveCombo = false;

    this.arrowDownPressTime = 0;
    this.arrowDownHoldTimer = null;
    this.arrowDownHoldTriggered = false;

    // Listen to state machine profile changes
    stateMachine.on('profile-changed', (profile) => {
      if (this.outputProfileChangeDispatcher) {
        this.outputProfileChangeDispatcher(profile);
      }
    });

    // Listen to armed state changes: when companion mode is deactivated, reset and halt all operations
    stateMachine.on('armed-changed', (isArmed) => {
      if (!isArmed) {
        this.resetAllState();
      }
    });
  }

  /**
   * Sets callback to notify UI when Companion output profile changes.
   * @param {(newProfile: string) => void} dispatcher
   */
  setOutputProfileChangeDispatcher(dispatcher) {
    this.outputProfileChangeDispatcher = dispatcher;
  }

  /**
   * Sets callback to notify UI when active model changes via global shortcut.
   * @param {(newModel: string) => void} dispatcher
   */
  setModelChangeDispatcher(dispatcher) {
    this.modelChangeDispatcher = dispatcher;
  }

  /**
   * Cycles active model: 3.5 -> 3.6 -> 3.8 -> 3.5
   * Plays corresponding earcon: 1x tut for 3.5, 2x tut for 3.6, 3x tut for 3.8
   */
  cycleActiveModel() {
    const ORDER = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'];
    const current = getActiveModel() || 'gemini-3.8-flash';
    const currentIndex = ORDER.indexOf(current);
    const nextIndex = (currentIndex + 1) % ORDER.length;
    const nextModel = ORDER[nextIndex];

    setActiveModel(nextModel);

    // Auditory feedback: 1x tut for 3.5, 2x tut for 3.6, 3x tut for 3.8
    if (nextModel === 'gemini-3.5-flash-lite') {
      earconSynth.playShortTut();
    } else if (nextModel === 'gemini-3.6-flash') {
      earconSynth.playDoubleShortTut();
    } else if (nextModel === 'gemini-3.8-flash') {
      earconSynth.playTripleShortTut();
    }

    if (this.modelChangeDispatcher) {
      this.modelChangeDispatcher(nextModel);
    }
  }

  /**
   * Registers handler for voice audio recording (bridged to Renderer MediaRecorder).
   * @param {Object} handler
   * @param {() => void} handler.start
   * @param {() => Promise<Buffer>} handler.stop
   */
  setVoiceRecordingHandler(handler) {
    this.audioRecordingHandler = handler;
  }

  /**
   * Starts global uiohook listener and native hooks.
   */
  start() {
    if (this.isListening) return;

    try {
      if (mouseSuppressor && typeof mouseSuppressor.installHook === 'function') {
        mouseSuppressor.installHook();
      }
    } catch (_err) {
      // Ignored
    }

    uIOhook.on('mousemove', (e) => this.handleMouseMove(e));
    uIOhook.on('keydown', (e) => this.handleKeyDown(e));
    uIOhook.on('keyup', (e) => this.handleKeyUp(e));
    uIOhook.on('mousedown', (e) => this.handleMouseDown(e));
    uIOhook.on('mouseup', (e) => this.handleMouseUp(e));

    try {
      uIOhook.start();
      this.isListening = true;
    } catch (_err) {
      this.isListening = false;
    }
  }

  /**
   * Stops global uiohook listener and releases native hooks.
   */
  stop() {
    if (!this.isListening) return;
    try {
      uIOhook.stop();
      if (mouseSuppressor && typeof mouseSuppressor.uninstallHook === 'function') {
        mouseSuppressor.uninstallHook();
      }
    } catch (_err) {
      // Ignored
    }
    this.isListening = false;
  }

  /**
   * Translates a raw uiohook keycode and shift state to character string.
   * @param {number} key
   * @param {boolean} isShift
   * @returns {string|null}
   */
  _translateKeyToChar(key, isShift) {
    if (KEY_TO_CHAR_LETTERS[key]) {
      const base = KEY_TO_CHAR_LETTERS[key];
      return isShift ? base.toUpperCase() : base.toLowerCase();
    }
    if (KEY_TO_CHAR_NUMBERS[key]) {
      return isShift ? KEY_TO_CHAR_NUMBERS[key].shift : KEY_TO_CHAR_NUMBERS[key].normal;
    }
    if (KEY_TO_CHAR_SYMBOLS[key]) {
      return isShift ? KEY_TO_CHAR_SYMBOLS[key].shift : KEY_TO_CHAR_SYMBOLS[key].normal;
    }
    return null;
  }

  handleMouseMove(e) {
    if (!stateMachine.isCompanionArmed()) return;
    this.currentMouse.x = e.x;
    this.currentMouse.y = e.y;
  }

  handleKeyDown(e) {
    if (!stateMachine.isCompanionArmed()) return;
    const key = e.keycode;
    if (this.keysDown.has(key)) return; // Prevent repeated auto-repeat triggers
    this.keysDown.add(key);

    const isRCtrl = this.keysDown.has(UiohookKey.CtrlRight);
    const isRShift = this.keysDown.has(UiohookKey.ShiftRight);
    const isRAlt = this.keysDown.has(UiohookKey.AltRight);
    const isLCtrl = this.keysDown.has(UiohookKey.Ctrl);
    const isLShift = this.keysDown.has(UiohookKey.Shift);
    const isShift = isLShift || isRShift || Boolean(e.shiftKey);
    const hasModifier = isRCtrl || isLCtrl || isRAlt || Boolean(e.ctrlKey) || Boolean(e.altKey) || Boolean(e.metaKey);

    // Concurrency Arbitration: notify Auto-Typer of physical keypress if active
    if (autoTyper.isActive && !autoTyper.isInjecting) {
      if (key !== UiohookKey.CtrlRight && key !== UiohookKey.AltRight) {
        autoTyper.onPhysicalKeyPress();
      }
    }

    // Toggle CapsLock active state
    if (key === UiohookKey.CapsLock) {
      this.isCapsLockActive = !this.isCapsLockActive;
      return;
    }

    // CapsLock Keystroke Capture: When CapsLock is active and no hotkey modifier is held, capture keystrokes as prompt for AI
    if (this.isCapsLockActive && !hasModifier && (!autoTyper.isActive || !autoTyper.isInjecting)) {
      if (key === UiohookKey.Backspace) {
        stagingBuffer.deleteLastChar();
        return;
      }
      if (key === UiohookKey.Space) {
        stagingBuffer.appendChar(' ');
        return;
      }
      if (key === UiohookKey.Enter || key === UiohookKey.NumpadEnter) {
        stagingBuffer.appendChar('\n');
        return;
      }
      if (key === UiohookKey.Tab) {
        stagingBuffer.appendChar('\t');
        return;
      }

      const ch = this._translateKeyToChar(key, isShift);
      if (ch) {
        stagingBuffer.appendChar(ch);
        return;
      }
    }

    // 0. Cycle Output Profile: R-CTRL + R-SHIFT (Tap)
    if ((isRCtrl && key === UiohookKey.ShiftRight) || (isRShift && key === UiohookKey.CtrlRight)) {
      if (stateMachine.getState() === 'IDLE') {
        stateMachine.cycleOutputProfile();
      }
      return;
    }

    // 1. Full Screen Capture OR Model Cycle Hold: R-CTRL + Arrow Up
    if (isRCtrl && (key === UiohookKey.ArrowUp || key === UiohookKey.NumpadArrowUp)) {
      if (stateMachine.getState() !== 'BUSY') {
        this.arrowUpPressTime = Date.now();
        this.arrowUpHoldTriggered = false;

        // Arm 400ms hold timer to cycle active model
        if (this.arrowUpHoldTimer) clearTimeout(this.arrowUpHoldTimer);
        this.arrowUpHoldTimer = setTimeout(() => {
          this.arrowUpHoldTriggered = true;
          this.cycleActiveModel();
        }, 400);
      }
      return;
    }

    // 2. Dynamic Region Capture: L-CTRL + L-SHIFT (Hold >= 1000ms, strictly without R-CTRL)
    if (isLCtrl && isLShift && !isRCtrl) {
      if (!this.regionHoldTimer && !screenCapture.isRegionSelecting) {
        this.isRegionTimerArmed = true;
        this.regionHoldTimer = setTimeout(() => {
          if (this.isRegionTimerArmed && stateMachine.getState() !== 'BUSY') {
            screenCapture.startRegionSelection(this.currentMouse);
          }
        }, 1000);
      }
    }

    // 3. Send Staged Items to AI: R-CTRL + Arrow Right
    if (isRCtrl && key === UiohookKey.ArrowRight) {
      if (stagingBuffer.hasItems() && stateMachine.getState() !== 'BUSY') {
        this.dispatchStagedItems();
      }
      return;
    }

    // 4. Clear Staged Items: R-CTRL + Delete
    if (isRCtrl && (key === UiohookKey.Delete || key === UiohookKey.NumpadDelete)) {
      if (stateMachine.getState() === 'STAGING') {
        stagingBuffer.clear();
      }
      return;
    }

    // 5. Answer Replay, Typing Trigger & Universal Interruption: R-CTRL + R-ALT
    if ((isRCtrl && key === UiohookKey.AltRight) || (isRAlt && key === UiohookKey.CtrlRight)) {
      this.isRAltActiveCombo = true;
      const now = Date.now();

      // DOUBLE-TAP (< 300ms between two presses / taps): HARD STOP / SILENCE ALL
      if ((now - this.lastRAltDownTime < 300) || (now - this.lastRAltUpTime < 300)) {
        this.isRAltDoubleTap = true;
        if (this.rAltHoldTimer) {
          clearTimeout(this.rAltHoldTimer);
          this.rAltHoldTimer = null;
        }
        if (this.rAltSingleTapTimer) {
          clearTimeout(this.rAltSingleTapTimer);
          this.rAltSingleTapTimer = null;
        }
        audioSession.killActiveAudio();
        autoTyper.abort();
        this.lastRAltDownTime = 0;
        this.lastRAltUpTime = 0;
        return;
      }

      this.isRAltDoubleTap = false;
      this.lastRAltDownTime = now;
      this.rAltHoldTriggered = false;

      if (this.rAltHoldTimer) clearTimeout(this.rAltHoldTimer);
      this.rAltHoldTimer = setTimeout(() => {
        this.rAltHoldTriggered = true;
        this.handleRAltHold();
      }, 500);
      return;
    }

    // 6. Reasoning / Mode Toggle: R-CTRL + Arrow Down (Press tracking)
    if (isRCtrl && (key === UiohookKey.ArrowDown || key === UiohookKey.NumpadArrowDown)) {
      if (stateMachine.getState() === 'IDLE') {
        this.arrowDownPressTime = Date.now();
        this.arrowDownHoldTriggered = false;

        // Arm 1000ms hold timer for Save/Throw toggle
        if (this.arrowDownHoldTimer) clearTimeout(this.arrowDownHoldTimer);
        this.arrowDownHoldTimer = setTimeout(() => {
          this.arrowDownHoldTriggered = true;
          stateMachine.toggleSubMode();
        }, 1000);
      }
      return;
    }
  }

  handleKeyUp(e) {
    if (!stateMachine.isCompanionArmed()) {
      this.keysDown.clear();
      return;
    }
    const key = e.keycode;
    this.keysDown.delete(key);

    // Full Screen Capture on Arrow Up release (if tapped < 400ms without hold)
    if (key === UiohookKey.ArrowUp || key === UiohookKey.NumpadArrowUp) {
      if (this.arrowUpHoldTimer) {
        clearTimeout(this.arrowUpHoldTimer);
        this.arrowUpHoldTimer = null;
      }

      if (this.arrowUpPressTime > 0) {
        const duration = Date.now() - this.arrowUpPressTime;
        this.arrowUpPressTime = 0;

        if (!this.arrowUpHoldTriggered && duration < 400) {
          if (stateMachine.getState() !== 'BUSY') {
            screenCapture.captureFullScreen();
          }
        }
      }
      this.arrowUpHoldTriggered = false;
    }

    // Cancel dynamic region hold timer if either L-CTRL or L-SHIFT released
    if (key === UiohookKey.Ctrl || key === UiohookKey.Shift) {
      if (this.regionHoldTimer) {
        clearTimeout(this.regionHoldTimer);
        this.regionHoldTimer = null;
      }
      this.isRegionTimerArmed = false;

      // If region selection was active, finish selection and crop
      if (screenCapture.isRegionSelecting) {
        screenCapture.finishRegionSelection(this.currentMouse);
      }
    }

    // Answer Replay / Typing Trigger on R-ALT or R-CTRL release (when combo was active)
    if (key === UiohookKey.AltRight || (key === UiohookKey.CtrlRight && this.isRAltActiveCombo)) {
      if (this.isRAltActiveCombo) {
        this.isRAltActiveCombo = false;
        const now = Date.now();
        if (this.rAltHoldTimer) {
          clearTimeout(this.rAltHoldTimer);
          this.rAltHoldTimer = null;
        }

        if (this.isRAltDoubleTap) {
          this.isRAltDoubleTap = false;
          return;
        }

        if (this.rAltHoldTriggered) {
          this.rAltHoldTriggered = false;
          return;
        }

        // Single Tap (< 500ms release)
        this.lastRAltUpTime = now;
        if (this.rAltSingleTapTimer) {
          clearTimeout(this.rAltSingleTapTimer);
        }
        this.rAltSingleTapTimer = setTimeout(() => {
          this.handleRAltSingleTap();
        }, 250);
        return;
      }
    }

    // Reasoning level cycle on Arrow Down release
    if (key === UiohookKey.ArrowDown || key === UiohookKey.NumpadArrowDown) {
      if (this.arrowDownHoldTimer) {
        clearTimeout(this.arrowDownHoldTimer);
        this.arrowDownHoldTimer = null;
      }

      if (this.arrowDownPressTime > 0) {
        const duration = Date.now() - this.arrowDownPressTime;
        this.arrowDownPressTime = 0;

        // If released within 400ms without hold trigger: cycle reasoning level
        if (!this.arrowDownHoldTriggered && duration < 400) {
          stateMachine.cycleReasoningLevel();
        }
      }
      this.arrowDownHoldTriggered = false;
    }
  }

  /**
   * Handles Single Tap (< 500ms) on R-CTRL + R-ALT.
   */
  handleRAltSingleTap() {
    audioSession.killActiveAudio();
    const profile = stateMachine.getOutputProfile();

    if (profile === 'SHORT_ANSWER') {
      const cached = companionCache.getShortAnswer();
      if (cached && cached.normal_text) {
        ttsEngine.speakAnswer(cached.normal_text, 1.0);
      } else {
        earconSynth.playDoubleLowTut();
      }
    } else if (profile === 'MULTIPLE_CHOICE') {
      const cached = companionCache.getMcq();
      if (cached && cached.option_index) {
        earconSynth.playNTuts(cached.option_index, { durationMs: 90, gapMs: 70 });
      } else {
        earconSynth.playDoubleLowTut();
      }
    } else if (profile === 'ESSAY' || profile === 'PROGRAMMING' || profile === 'MATHEMATICS') {
      const content = companionCache.getTextContent(profile);
      if (content) {
        try {
          if (clipboard && typeof clipboard.writeText === 'function') {
            clipboard.writeText(content);
          }
        } catch (_err) {
          // Ignored
        }
        earconSynth.playShortTut(); // 1x Short Tut (880 Hz, 90ms) on copy
      } else {
        earconSynth.playDoubleLowTut();
      }
    }
  }

  /**
   * Handles Hold (>= 500ms) on R-CTRL + R-ALT.
   */
  handleRAltHold() {
    audioSession.killActiveAudio();
    const profile = stateMachine.getOutputProfile();

    if (profile === 'SHORT_ANSWER') {
      const cached = companionCache.getShortAnswer();
      const textToSpeak = (cached && (cached.paced_text || cached.normal_text)) || '';
      if (textToSpeak) {
        ttsEngine.speakAnswer(textToSpeak, 0.75);
      } else {
        earconSynth.playDoubleLowTut();
      }
    } else if (profile === 'MULTIPLE_CHOICE') {
      const cached = companionCache.getMcq();
      if (cached && cached.option_index) {
        earconSynth.playNTuts(cached.option_index, { durationMs: 180, gapMs: 150 });
      } else {
        earconSynth.playDoubleLowTut();
      }
    } else if (profile === 'ESSAY' || profile === 'PROGRAMMING' || profile === 'MATHEMATICS') {
      const content = companionCache.getTextContent(profile);
      if (autoTyper.isActive) {
        autoTyper.abort();
        earconSynth.playDoubleLowTut(); // 2x low tut (440 Hz) on cancel
      } else {
        if (content) {
          autoTyper.start(content);
        } else {
          earconSynth.playDoubleLowTut();
        }
      }
    }
  }

  handleMouseDown(e) {
    if (!stateMachine.isCompanionArmed()) return;
    const button = e.button;
    this.mouseButtonsDown.add(button);

    // Push-to-Talk: Mouse Left (1) + Mouse Right (2) Hold >= 1000ms
    if (this.mouseButtonsDown.has(1) && this.mouseButtonsDown.has(2)) {
      if (!this.voiceHoldTimer && !this.isVoiceRecording) {
        this.voiceHoldTimer = setTimeout(() => {
          if (
            this.mouseButtonsDown.has(1) &&
            this.mouseButtonsDown.has(2) &&
            stateMachine.getState() !== 'BUSY'
          ) {
            this.startVoiceCapture();
          }
        }, 1000);
      }
    }
  }

  handleMouseUp(e) {
    if (!stateMachine.isCompanionArmed()) {
      this.mouseButtonsDown.clear();
      return;
    }
    const button = e.button;
    this.mouseButtonsDown.delete(button);

    // Cancel voice hold timer if buttons released before 1000ms
    if (this.voiceHoldTimer) {
      clearTimeout(this.voiceHoldTimer);
      this.voiceHoldTimer = null;
    }

    // If active voice recording is running, release triggers stop & transcription
    if (this.isVoiceRecording) {
      this.stopVoiceCapture();
    }
  }

  /**
   * Resets all key/mouse down sets, clears timers, aborts auto-typer, silences audio,
   * cancels region selection, and clears the staging buffer when companion mode is deactivated.
   */
  resetAllState() {
    this.keysDown.clear();
    this.mouseButtonsDown.clear();
    this.isCapsLockActive = false;
    this.isVoiceRecording = false;

    if (this.arrowUpHoldTimer) {
      clearTimeout(this.arrowUpHoldTimer);
      this.arrowUpHoldTimer = null;
    }
    if (this.rAltHoldTimer) {
      clearTimeout(this.rAltHoldTimer);
      this.rAltHoldTimer = null;
    }
    if (this.rAltSingleTapTimer) {
      clearTimeout(this.rAltSingleTapTimer);
      this.rAltSingleTapTimer = null;
    }
    if (this.arrowDownHoldTimer) {
      clearTimeout(this.arrowDownHoldTimer);
      this.arrowDownHoldTimer = null;
    }
    if (this.regionHoldTimer) {
      clearTimeout(this.regionHoldTimer);
      this.regionHoldTimer = null;
    }
    if (this.voiceHoldTimer) {
      clearTimeout(this.voiceHoldTimer);
      this.voiceHoldTimer = null;
    }

    this.isRegionTimerArmed = false;
    this.arrowUpHoldTriggered = false;
    this.rAltHoldTriggered = false;
    this.arrowDownHoldTriggered = false;
    this.isRAltDoubleTap = false;
    this.isRAltActiveCombo = false;
    this.lastRAltDownTime = 0;
    this.lastRAltUpTime = 0;

    autoTyper.abort();
    audioSession.killActiveAudio();

    if (screenCapture && screenCapture.isRegionSelecting) {
      screenCapture.cancelRegionSelection();
    }

    if (mouseSuppressor && typeof mouseSuppressor.disableSuppression === 'function') {
      try {
        mouseSuppressor.disableSuppression();
      } catch (_err) {}
    }

    stagingBuffer.clear();
  }

  startVoiceCapture() {
    this.isVoiceRecording = true;
    earconSynth.playShortTut();

    if (this.audioRecordingHandler && typeof this.audioRecordingHandler.start === 'function') {
      this.audioRecordingHandler.start();
    }
  }

  async stopVoiceCapture() {
    this.isVoiceRecording = false;

    // Suppress the upcoming Windows right-click context menu (WM_RBUTTONUP)
    try {
      if (mouseSuppressor && typeof mouseSuppressor.enableSuppression === 'function') {
        mouseSuppressor.enableSuppression();
      }
    } catch (_err) {
      // Ignored
    }

    earconSynth.playShortTut();

    if (this.audioRecordingHandler && typeof this.audioRecordingHandler.stop === 'function') {
      try {
        const audioBuffer = await this.audioRecordingHandler.stop();
        if (audioBuffer && audioBuffer.length > 0) {
          const transcribedText = await transcribeAudio(audioBuffer);
          if (transcribedText) {
            stagingBuffer.appendText(transcribedText);
          }
        }
      } catch (_err) {
        // Ignored
      }
    }
  }

  async dispatchStagedItems() {
    earconSynth.playLongTut(); // 1x Long Tut (350ms)
    const payload = stagingBuffer.extractPayloadForDispatch();

    try {
      await geminiService.processCompanionPayload({
        images: payload.images,
        text: payload.text,
        subMode: stateMachine.getSubMode(),
        reasoningLevel: stateMachine.getReasoningLevel(),
        outputProfile: stateMachine.getOutputProfile(),
      });
    } catch (_err) {
      // Key pool triggers rate limit alert if all keys exhausted
    } finally {
      stateMachine.setState('IDLE');
    }
  }
}

const hookManager = new HookManager();

module.exports = {
  hookManager,
};
