const EventEmitter = require('events');
const { earconSynth } = require('../audio/earcon-synth');
const {
  getSetting,
  setSetting,
  getOutputProfile,
  setOutputProfile,
} = require('../database/repositories/settings-repo');

class CompanionStateMachine extends EventEmitter {
  constructor() {
    super();
    this.state = 'IDLE'; // 'IDLE' | 'STAGING' | 'BUSY'
    this.subMode = getSetting('companion_sub_mode', 'save'); // 'save' | 'throw'
    this.reasoningLevel = getSetting('reasoning_level', 'low'); // 'low' | 'medium' | 'high'
    this.outputProfile = getOutputProfile(); // 'SHORT_ANSWER' | 'MULTIPLE_CHOICE' | 'ESSAY'
    this.isArmed = Boolean(getSetting('companion_armed', false));
  }

  getState() {
    return this.state;
  }

  getSubMode() {
    return this.subMode;
  }

  getReasoningLevel() {
    return this.reasoningLevel;
  }

  isCompanionArmed() {
    return this.isArmed;
  }

  /**
   * Sets the armed status of Companion mode.
   * @param {boolean} armed
   */
  setArmed(armed) {
    this.isArmed = Boolean(armed);
    setSetting('companion_armed', this.isArmed);
    this.emit('armed-changed', this.isArmed);
    this.emit('change', this.getSnapshot());
  }

  /**
   * Updates the core state ('IDLE', 'STAGING', 'BUSY').
   * @param {'IDLE'|'STAGING'|'BUSY'} newState
   */
  setState(newState) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.emit('state-changed', { oldState, newState });
      this.emit('change', this.getSnapshot());
    }
  }

  /**
   * Toggles Companion sub-mode between 'save' and 'throw'.
   * Strictly restricted to when the system is IDLE.
   * @returns {boolean} Whether the toggle succeeded
   */
  toggleSubMode() {
    if (this.state === 'BUSY') {
      return false;
    }

    if (this.subMode === 'save') {
      this.subMode = 'throw';
      setSetting('companion_sub_mode', 'throw');
      earconSynth.playDoubleLongTut(); // 2x Long Tut (350ms)
    } else {
      this.subMode = 'save';
      setSetting('companion_sub_mode', 'save');
      earconSynth.playLongTut(); // 1x Long Tut (350ms)
    }

    this.emit('mode-changed', this.subMode);
    this.emit('change', this.getSnapshot());
    return true;
  }

  /**
   * Directly sets the sub-mode ('save' or 'throw').
   * @param {'save'|'throw'} mode
   */
  setSubMode(mode) {
    const target = mode === 'throw' ? 'throw' : 'save';
    if (this.subMode !== target) {
      this.subMode = target;
      setSetting('companion_sub_mode', target);
      this.emit('mode-changed', this.subMode);
      this.emit('change', this.getSnapshot());
    }
  }

  /**
   * Cycles reasoning level sequentially: low -> medium -> high -> low.
   * Strictly restricted to when system is IDLE.
   * @returns {boolean} Whether cycling succeeded
   */
  cycleReasoningLevel() {
    if (this.state === 'BUSY') {
      return false;
    }

    switch (this.reasoningLevel) {
      case 'low':
        this.reasoningLevel = 'medium';
        earconSynth.playDoubleShortTut(); // 2x Rapid Short Tut
        break;
      case 'medium':
        this.reasoningLevel = 'high';
        earconSynth.playTripleShortTut(); // 3x Rapid Short Tut
        break;
      case 'high':
      default:
        this.reasoningLevel = 'low';
        earconSynth.playShortTut(); // 1x Short Tut
        break;
    }

    setSetting('reasoning_level', this.reasoningLevel);
    this.emit('reasoning-changed', this.reasoningLevel);
    this.emit('change', this.getSnapshot());
    return true;
  }

  /**
   * Directly sets the reasoning level.
   * @param {'low'|'medium'|'high'} level
   */
  setReasoningLevel(level) {
    const valid = ['low', 'medium', 'high'].includes(level) ? level : 'low';
    if (this.reasoningLevel !== valid) {
      this.reasoningLevel = valid;
      setSetting('reasoning_level', valid);
      this.emit('reasoning-changed', valid);
      this.emit('change', this.getSnapshot());
    }
  }

  /**
   * Returns current Companion output profile.
   * @returns {'SHORT_ANSWER'|'MULTIPLE_CHOICE'|'ESSAY'|'PROGRAMMING'|'MATHEMATICS'}
   */
  getOutputProfile() {
    return this.outputProfile || getOutputProfile();
  }

  /**
   * Directly sets the Companion output profile.
   * @param {'SHORT_ANSWER'|'MULTIPLE_CHOICE'|'ESSAY'|'PROGRAMMING'|'MATHEMATICS'} profile
   */
  setOutputProfile(profile) {
    const valid = setOutputProfile(profile);
    if (this.outputProfile !== valid) {
      this.outputProfile = valid;
      this.emit('profile-changed', valid);
      this.emit('change', this.getSnapshot());
    }
    return valid;
  }

  /**
   * Cycles output profile: SHORT_ANSWER -> MULTIPLE_CHOICE -> ESSAY -> PROGRAMMING -> MATHEMATICS -> SHORT_ANSWER.
   * Plays corresponding earcon feedback:
   * - SHORT_ANSWER: 1x Short Tut (880 Hz, 90ms)
   * - MULTIPLE_CHOICE: 2x Rapid Short Tut (880 Hz, 90ms, 70ms gap)
   * - ESSAY: 3x Rapid Short Tut (880 Hz, 90ms, 70ms gap)
   * - PROGRAMMING: 4x Rapid Short Tut (880 Hz, 90ms, 70ms gap)
   * - MATHEMATICS: 5x Rapid Short Tut (880 Hz, 90ms, 70ms gap)
   * @returns {string|null} The next profile, or null if system is BUSY
   */
  cycleOutputProfile() {
    if (this.state === 'BUSY') {
      return null;
    }

    const ORDER = ['SHORT_ANSWER', 'MULTIPLE_CHOICE', 'ESSAY', 'PROGRAMMING', 'MATHEMATICS'];
    const current = this.getOutputProfile();
    const currentIndex = ORDER.indexOf(current);
    const nextIndex = (currentIndex + 1) % ORDER.length;
    const nextProfile = ORDER[nextIndex];

    this.setOutputProfile(nextProfile);

    // Audio earcon feedback
    if (nextProfile === 'SHORT_ANSWER') {
      earconSynth.playShortTut();
    } else if (nextProfile === 'MULTIPLE_CHOICE') {
      earconSynth.playDoubleShortTut();
    } else if (nextProfile === 'ESSAY') {
      earconSynth.playTripleShortTut();
    } else if (nextProfile === 'PROGRAMMING') {
      earconSynth.playNTuts(4, { durationMs: 90, gapMs: 70 });
    } else if (nextProfile === 'MATHEMATICS') {
      earconSynth.playNTuts(5, { durationMs: 90, gapMs: 70 });
    }

    return nextProfile;
  }

  /**
   * Returns a complete state snapshot.
   */
  getSnapshot() {
    return {
      state: this.state,
      subMode: this.subMode,
      reasoningLevel: this.reasoningLevel,
      outputProfile: this.getOutputProfile(),
      isArmed: this.isArmed,
    };
  }
}

const stateMachine = new CompanionStateMachine();

module.exports = {
  stateMachine,
};
