const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { stateMachine } = require('./state-machine');
const { stagingBuffer } = require('./staging-buffer');
const { screenCapture } = require('./screen-capture');
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

class HookManager {
  constructor() {
    this.isListening = false;
    this.audioRecordingHandler = null; // Callback: (action: 'start'|'stop') => Promise<Buffer>
    this.modelChangeDispatcher = null; // Callback: (newModel: string) => void

    // Keyboard state
    this.keysDown = new Set();
    this.currentMouse = { x: 0, y: 0 };

    // Timers & tracking states
    this.regionHoldTimer = null;
    this.isRegionTimerArmed = false;

    this.mouseButtonsDown = new Set();
    this.voiceHoldTimer = null;
    this.isVoiceRecording = false;

    this.arrowUpPressTime = 0;
    this.arrowUpHoldTimer = null;
    this.arrowUpHoldTriggered = false;

    this.arrowLeftPressTime = 0;
    this.arrowDownPressTime = 0;
    this.arrowDownHoldTimer = null;
    this.arrowDownHoldTriggered = false;
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

  handleMouseMove(e) {
    this.currentMouse.x = e.x;
    this.currentMouse.y = e.y;
  }

  handleKeyDown(e) {
    const key = e.keycode;
    if (this.keysDown.has(key)) return; // Prevent repeated auto-repeat triggers
    this.keysDown.add(key);

    const isRCtrl = this.keysDown.has(UiohookKey.CtrlRight);
    const isLCtrl = this.keysDown.has(UiohookKey.Ctrl);
    const isLShift = this.keysDown.has(UiohookKey.Shift);

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

    // 5. Replay Last AI Answer: R-CTRL + Arrow Left (Press tracking)
    if (isRCtrl && (key === UiohookKey.ArrowLeft || key === UiohookKey.NumpadArrowLeft)) {
      this.arrowLeftPressTime = Date.now();
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

    // Replay Last Answer on Arrow Left release
    if (key === UiohookKey.ArrowLeft || key === UiohookKey.NumpadArrowLeft) {
      if (this.arrowLeftPressTime > 0) {
        const duration = Date.now() - this.arrowLeftPressTime;
        this.arrowLeftPressTime = 0;

        if (duration >= 500) {
          // Hold >= 500ms: Replay slow speed (0.75x)
          ttsEngine.replayLastAnswer(0.75);
        } else {
          // Tap < 500ms: Replay normal speed (1.0x)
          ttsEngine.replayLastAnswer(1.0);
        }
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

  handleMouseDown(e) {
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
