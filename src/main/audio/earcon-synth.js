const path = require('path');
const { getVolumes, getAudioDeviceId } = require('../database/repositories/settings-repo');
const { audioSession } = require('./audio-session');

const SAMPLE_RATE = 44100;

let mouseSuppressor = null;
try {
  mouseSuppressor = require(path.join(__dirname, '../../../native-addons/build/Release/mouse_suppressor.node'));
} catch (_errRelease) {
  try {
    mouseSuppressor = require(path.join(__dirname, '../../../native-addons/build/Debug/mouse_suppressor.node'));
  } catch (_errDebug) {
    mouseSuppressor = null;
  }
}

const PATTERN_SPECS = {
  short: { frequency: 880, waveType: 'sine', durationMs: 90, count: 1, gapMs: 0 },
  'short-tut': { frequency: 880, waveType: 'sine', durationMs: 90, count: 1, gapMs: 0 },
  long: { frequency: 880, waveType: 'sine', durationMs: 350, count: 1, gapMs: 0 },
  'long-tut': { frequency: 880, waveType: 'sine', durationMs: 350, count: 1, gapMs: 0 },
  'double-short': { frequency: 880, waveType: 'sine', durationMs: 90, count: 2, gapMs: 70 },
  'triple-short': { frequency: 880, waveType: 'sine', durationMs: 90, count: 3, gapMs: 70 },
  'double-long': { frequency: 880, waveType: 'sine', durationMs: 350, count: 2, gapMs: 70 },
  'double-low': { frequency: 440, waveType: 'triangle', durationMs: 110, count: 2, gapMs: 70 },
  'triple-low': { frequency: 440, waveType: 'triangle', durationMs: 110, count: 3, gapMs: 70 },
};

/**
 * Creates a 44-byte RIFF WAV header for 16-bit mono PCM.
 * @param {number} dataSizeBytes
 * @returns {Buffer}
 */
function createWavHeader(dataSizeBytes) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSizeBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(1, 22);  // NumChannels (1 = Mono)
  buffer.writeUInt32LE(SAMPLE_RATE, 24); // SampleRate
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(2, 32);  // BlockAlign (NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSizeBytes, 40);
  return buffer;
}

/**
 * Synthesizes a tone segment with 10ms fade-in and 10ms fade-out.
 * @param {number} freq - Frequency in Hz (e.g., 880 or 440)
 * @param {'sine'|'triangle'} waveType
 * @param {number} durationMs - Duration in milliseconds
 * @param {number} volume - 0.0 to 1.0
 * @returns {Int16Array}
 */
function synthesizeToneSamples(freq, waveType, durationMs, volume = 0.8) {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const fadeSamples = Math.min(Math.floor((SAMPLE_RATE * 10) / 1000), Math.floor(numSamples / 2));
  const samples = new Int16Array(numSamples);
  const amplitude = 32767 * Math.max(0, Math.min(1, volume));

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    let raw = 0;

    if (waveType === 'sine') {
      raw = Math.sin(2 * Math.PI * freq * t);
    } else if (waveType === 'triangle') {
      // Periodic triangle wave using arcsin of sine
      raw = (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freq * t));
    }

    // Apply 10ms fade-in and fade-out envelope
    let envelope = 1.0;
    if (i < fadeSamples) {
      envelope = i / fadeSamples;
    } else if (i > numSamples - fadeSamples) {
      envelope = (numSamples - i) / fadeSamples;
    }

    const sampleVal = Math.round(raw * envelope * amplitude);
    samples[i] = Math.max(-32768, Math.min(32767, sampleVal));
  }

  return samples;
}

/**
 * Generates an in-memory WAV buffer composed of multi-tone pulses with silence gaps.
 * @param {Object} options
 * @param {number} options.frequency - Tone frequency in Hz (880 or 440)
 * @param {'sine'|'triangle'} options.waveType
 * @param {number} options.durationMs - Duration per pulse in ms
 * @param {number} [options.count=1] - Number of tone pulses
 * @param {number} [options.gapMs=70] - Gap between consecutive pulses in ms
 * @param {number} [options.volume] - Master volume (0.0 to 1.0)
 * @returns {Buffer} WAV file buffer
 */
function generateWavBuffer({
  frequency,
  waveType = 'sine',
  durationMs,
  count = 1,
  gapMs = 70,
  volume = 0.8,
}) {
  const toneSamples = synthesizeToneSamples(frequency, waveType, durationMs, volume);
  const gapSamples = Math.floor((SAMPLE_RATE * gapMs) / 1000);
  const totalSamplesCount = (toneSamples.length * count) + (gapSamples * Math.max(0, count - 1));
  const combined = new Int16Array(totalSamplesCount);

  let offset = 0;
  for (let c = 0; c < count; c++) {
    combined.set(toneSamples, offset);
    offset += toneSamples.length;
    if (c < count - 1) {
      // Gap is zeros (silence)
      offset += gapSamples;
    }
  }

  const pcmBytes = Buffer.from(combined.buffer);
  const header = createWavHeader(pcmBytes.length);
  return Buffer.concat([header, pcmBytes]);
}

/**
 * Dispatcher mechanism to play synthesized earcon WAV buffers via Renderer Web Audio API.
 */
class EarconSynthesizer {
  constructor() {
    this.playbackDispatcher = null;
    this.activePlaybackToken = 0;
    this.activeTimers = new Set();

    // Ensure interrupting TTS or hard-stop immediately cancels any active earcon cursor pulse sequence
    audioSession.onStop(() => {
      this.cancelActiveEarcon();
    });
  }

  /**
   * Registers a dispatcher callback (typically bridging to Electron's IPC).
   * @param {Function} dispatcher - (wavBuffer: Buffer, sinkId: string) => void
   */
  setDispatcher(dispatcher) {
    this.playbackDispatcher = dispatcher;
  }

  /**
   * Safely sets or restores the Win32 busy cursor via the native C++ addon.
   * @param {boolean} busy
   */
  _setCursorBusy(busy) {
    try {
      if (mouseSuppressor && typeof mouseSuppressor.setBusyCursor === 'function') {
        mouseSuppressor.setBusyCursor(Boolean(busy));
      }
    } catch (_err) {
      // Ignored: never block audio synthesis if cursor API fails
    }
  }

  /**
   * Cancels any active earcon cursor pulse timers and restores the default OS cursor.
   */
  cancelActiveEarcon() {
    this.activePlaybackToken++;
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this._setCursorBusy(false);
  }

  /**
   * Schedules system busy-cursor pulses synchronized with tone ON durations and OFF silence gaps.
   * @param {number} token
   * @param {number} count
   * @param {number} durationMs
   * @param {number} gapMs
   */
  _scheduleCursorPulses(token, count, durationMs, gapMs) {
    const safeCount = Math.max(1, count);
    let offsetMs = 0;

    const scheduleAt = (delayMs, busyState) => {
      if (delayMs <= 0) {
        if (token === this.activePlaybackToken) {
          this._setCursorBusy(busyState);
        }
        return;
      }
      const timer = setTimeout(() => {
        this.activeTimers.delete(timer);
        if (token !== this.activePlaybackToken) {
          return;
        }
        this._setCursorBusy(busyState);
      }, delayMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.activeTimers.add(timer);
    };

    for (let i = 0; i < safeCount; i++) {
      scheduleAt(offsetMs, true);
      offsetMs += durationMs;
      scheduleAt(offsetMs, false);
      if (i < safeCount - 1) {
        offsetMs += gapMs;
      }
    }
  }

  /**
   * Synthesizes WAV buffer, dispatches playback, and synchronizes OS cursor pulsing.
   * @param {{ frequency: number, waveType: 'sine'|'triangle', durationMs: number, count: number, gapMs: number }} spec
   * @param {number} volume
   * @param {string|null} sinkId
   * @returns {Buffer}
   */
  _dispatchEarcon(spec, volume, sinkId) {
    const wavBuffer = generateWavBuffer({
      frequency: spec.frequency,
      waveType: spec.waveType,
      durationMs: spec.durationMs,
      count: spec.count,
      gapMs: spec.gapMs,
      volume,
    });

    const token = ++this.activePlaybackToken;

    if (this.playbackDispatcher && wavBuffer) {
      let dispatched = false;
      try {
        this._scheduleCursorPulses(token, spec.count, spec.durationMs, spec.gapMs);
        this.playbackDispatcher(wavBuffer, sinkId);
        dispatched = true;
      } finally {
        if (!dispatched) {
          this.cancelActiveEarcon();
        }
      }
    }

    return wavBuffer;
  }

  /**
   * Plays a synthesized earcon by name/pattern.
   * @param {string} pattern
   * @returns {Buffer}
   */
  play(pattern) {
    audioSession.killActiveAudio();
    const { earconVolume } = getVolumes();
    const sinkId = getAudioDeviceId();
    const spec = PATTERN_SPECS[pattern] || PATTERN_SPECS.short;
    return this._dispatchEarcon(spec, earconVolume, sinkId);
  }

  // Convenience helper methods corresponding to design.md specification
  playShortTut() {
    return this.play('short-tut');
  }

  playLongTut() {
    return this.play('long-tut');
  }

  playDoubleShortTut() {
    return this.play('double-short');
  }

  playTripleShortTut() {
    return this.play('triple-short');
  }

  playDoubleLongTut() {
    return this.play('double-long');
  }

  playDoubleLowTut() {
    return this.play('double-low');
  }

  playTripleLowTut() {
    return this.play('triple-low');
  }

  /**
   * Plays N consecutive 880 Hz tut tones (sine wave) for MCQ answer feedback and replay.
   * @param {number} count - 1-based option index (1 to N)
   * @param {Object} [options]
   * @param {number} [options.durationMs=90] - 90ms for normal, 180ms for slow
   * @param {number} [options.gapMs=70] - 70ms for normal, 150ms for slow
   * @returns {Buffer}
   */
  playNTuts(count, { durationMs = 90, gapMs = 70 } = {}) {
    audioSession.killActiveAudio();
    const n = Math.max(1, Math.min(20, parseInt(count, 10) || 1));
    const { earconVolume } = getVolumes();
    const sinkId = getAudioDeviceId();

    return this._dispatchEarcon(
      {
        frequency: 880,
        waveType: 'sine',
        durationMs,
        count: n,
        gapMs,
      },
      earconVolume,
      sinkId
    );
  }
}

const earconSynth = new EarconSynthesizer();

module.exports = {
  earconSynth,
  generateWavBuffer,
  createWavHeader,
  synthesizeToneSamples,
};
