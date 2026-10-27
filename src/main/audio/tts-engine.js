const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { getVolumes, getAudioDeviceId } = require('../database/repositories/settings-repo');

const ALL_KEYS_EXHAUSTED_MESSAGE = 'All API keys have reached their rate limit. Please wait a moment.';
const PRIMARY_VOICE = 'en-US-AndrewNeural';
const FALLBACK_VOICE = 'en-US-AvaNeural';

class TTSEngine {
  constructor() {
    this.ttsClient = null;
    this.activeVoice = PRIMARY_VOICE;
    this.lastAnswerBuffer = null;
    this.lastAnswerText = '';
    this.rateLimitFallbackBuffer = null;
    this.playbackDispatcher = null;
    this.isInitializing = false;
  }

  /**
   * Sets the playback dispatcher callback (bridged to Electron IPC).
   * @param {Function} dispatcher - (audioBuffer: Buffer, playbackRate: number, volume: number, sinkId: string) => void
   */
  setDispatcher(dispatcher) {
    this.playbackDispatcher = dispatcher;
  }

  /**
   * Initializes the msedge-tts client with selected voice.
   */
  async initClient() {
    if (this.ttsClient) return this.ttsClient;
    try {
      this.ttsClient = new MsEdgeTTS();
      await this.ttsClient.setMetadata(
        this.activeVoice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
      );
    } catch (_err) {
      // Fallback voice if primary voice fails
      try {
        this.activeVoice = FALLBACK_VOICE;
        this.ttsClient = new MsEdgeTTS();
        await this.ttsClient.setMetadata(
          this.activeVoice,
          OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
        );
      } catch (_err2) {
        // Handled per request
      }
    }
    return this.ttsClient;
  }

  /**
   * Synthesizes plain English text into an in-memory MP3 Buffer.
   * @param {string} text
   * @param {Object} [options]
   * @param {string} [options.rate] - e.g., '+0%', '-25%'
   * @returns {Promise<Buffer>}
   */
  async synthesizeToBuffer(text, options = {}) {
    if (!text || !text.trim()) {
      return Buffer.alloc(0);
    }

    const client = await this.initClient();
    if (!client) {
      throw new Error('TTS client failed to initialize');
    }

    const cleanText = text.trim();
    const stream = client.toStream(cleanText, options);

    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }

  /**
   * Speaks the AI response text, caches the audio buffer in RAM, and dispatches playback.
   * @param {string} text
   * @param {number} [rate=1.0]
   * @returns {Promise<Buffer>}
   */
  async speakAnswer(text, rate = 1.0) {
    if (!text || !text.trim()) {
      return Buffer.alloc(0);
    }

    try {
      const buffer = await this.synthesizeToBuffer(text);
      this.lastAnswerBuffer = buffer;
      this.lastAnswerText = text;

      this.dispatchAudio(buffer, rate);
      return buffer;
    } catch (_err) {
      return Buffer.alloc(0);
    }
  }

  /**
   * Replays the most recent AI answer from RAM cache.
   * @param {number} [speed=1.0] - 1.0 for normal speed, 0.75 for slow speed
   * @returns {boolean} Whether audio buffer was available and dispatched
   */
  replayLastAnswer(speed = 1.0) {
    if (!this.lastAnswerBuffer || this.lastAnswerBuffer.length === 0) {
      return false;
    }

    const playbackRate = speed === 0.75 ? 0.75 : 1.0;
    this.dispatchAudio(this.lastAnswerBuffer, playbackRate);
    return true;
  }

  /**
   * Plays the pre-synthesized or synthesized "All API keys exhausted" alert.
   */
  async speakRateLimitAlert() {
    try {
      if (!this.rateLimitFallbackBuffer) {
        this.rateLimitFallbackBuffer = await this.synthesizeToBuffer(ALL_KEYS_EXHAUSTED_MESSAGE);
      }
      this.dispatchAudio(this.rateLimitFallbackBuffer, 1.0);
    } catch (_err) {
      // Handled silently
    }
  }

  /**
   * Helper to dispatch audio playback to Renderer Web Audio API.
   * @param {Buffer} buffer
   * @param {number} rate
   */
  dispatchAudio(buffer, rate = 1.0) {
    if (!buffer || buffer.length === 0) return;
    const { ttsVolume } = getVolumes();
    const sinkId = getAudioDeviceId();

    if (this.playbackDispatcher) {
      this.playbackDispatcher(buffer, rate, ttsVolume, sinkId);
    }
  }

  /**
   * Warm-ups the TTS engine and pre-synthesizes the rate limit alert in the background.
   */
  async warmUp() {
    if (this.isInitializing) return;
    this.isInitializing = true;
    try {
      await this.initClient();
      this.rateLimitFallbackBuffer = await this.synthesizeToBuffer(ALL_KEYS_EXHAUSTED_MESSAGE);
    } catch (_e) {
      // Ignored during startup warmup
    } finally {
      this.isInitializing = false;
    }
  }
}

const ttsEngine = new TTSEngine();

module.exports = {
  ttsEngine,
  ALL_KEYS_EXHAUSTED_MESSAGE,
};
