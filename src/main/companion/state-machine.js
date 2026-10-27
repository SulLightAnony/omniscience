const EventEmitter = require('events');
const { earconSynth } = require('../audio/earcon-synth');
const { getSetting, setSetting } = require('../database/repositories/settings-repo');

class CompanionStateMachine extends EventEmitter {
  constructor() {
    super();
    this.state = 'IDLE'; // 'IDLE' | 'STAGING' | 'BUSY'
    this.subMode = getSetting('companion_sub_mode', 'save'); // 'save' | 'throw'
    this.reasoningLevel = getSetting('reasoning_level', 'low'); // 'low' | 'medium' | 'high'
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
   * Returns a complete state snapshot.
   */
  getSnapshot() {
    return {
      state: this.state,
      subMode: this.subMode,
      reasoningLevel: this.reasoningLevel,
      isArmed: this.isArmed,
    };
  }
}

const stateMachine = new CompanionStateMachine();

module.exports = {
  stateMachine,
};
