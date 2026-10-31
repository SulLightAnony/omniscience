const EventEmitter = require('events');
const { stateMachine } = require('./state-machine');
const { earconSynth } = require('../audio/earcon-synth');

class StagingBuffer extends EventEmitter {
  constructor() {
    super();
    this.images = []; // Array of Buffer
    this.text = '';   // Concatenated transcribed text
  }

  /**
   * Appends an in-memory JPEG screenshot buffer.
   * @param {Buffer} imageBuffer
   */
  addImage(imageBuffer) {
    if (!imageBuffer || imageBuffer.length === 0) return;
    this.images.push(imageBuffer);

    if (stateMachine.getState() === 'IDLE') {
      stateMachine.setState('STAGING');
    }
    this.emit('changed', this.getSnapshot());
  }

  /**
   * Appends transcribed English voice text to the staging buffer.
   * @param {string} newText
   */
  appendText(newText) {
    const trimmed = String(newText || '').trim();
    if (!trimmed) return;

    if (this.text.length > 0) {
      this.text += `\n${trimmed}`;
    } else {
      this.text = trimmed;
    }

    if (stateMachine.getState() === 'IDLE') {
      stateMachine.setState('STAGING');
    }
    this.emit('changed', this.getSnapshot());
  }

  /**
   * Appends a single character from CapsLock keyboard typing.
   * @param {string} char
   */
  appendChar(char) {
    if (!char) return;
    this.text += char;

    if (stateMachine.getState() === 'IDLE') {
      stateMachine.setState('STAGING');
    }
    this.emit('changed', this.getSnapshot());
  }

  /**
   * Deletes the last character from CapsLock keyboard typing (Backspace).
   */
  deleteLastChar() {
    if (this.text.length > 0) {
      this.text = this.text.slice(0, -1);
      if (this.images.length === 0 && this.text.trim().length === 0) {
        if (stateMachine.getState() === 'STAGING') {
          stateMachine.setState('IDLE');
        }
      }
      this.emit('changed', this.getSnapshot());
    }
  }

  /**
   * Clears all staged screenshots and transcribed text.
   * Plays the 2x Low Tut cancellation tone and resets state to IDLE.
   */
  clear() {
    const hadItems = this.hasItems();
    this.images = [];
    this.text = '';

    if (hadItems) {
      earconSynth.playDoubleLowTut();
    }

    if (stateMachine.getState() === 'STAGING') {
      stateMachine.setState('IDLE');
    }
    this.emit('changed', this.getSnapshot());
  }

  /**
   * Retrieves the accumulated payload and resets the buffer, setting state to BUSY.
   * @returns {{ images: Array<Buffer>, text: string }}
   */
  extractPayloadForDispatch() {
    const payload = {
      images: [...this.images],
      text: this.text,
    };

    this.images = [];
    this.text = '';
    stateMachine.setState('BUSY');
    this.emit('changed', this.getSnapshot());
    return payload;
  }

  /**
   * Checks whether the staging buffer contains any items.
   * @returns {boolean}
   */
  hasItems() {
    return this.images.length > 0 || this.text.trim().length > 0;
  }

  /**
   * Returns a lightweight snapshot for UI or logging.
   */
  getSnapshot() {
    return {
      imageCount: this.images.length,
      hasText: this.text.trim().length > 0,
      textPreview: this.text.length > 60 ? `${this.text.substring(0, 57)}...` : this.text,
    };
  }
}

const stagingBuffer = new StagingBuffer();

module.exports = {
  stagingBuffer,
};
