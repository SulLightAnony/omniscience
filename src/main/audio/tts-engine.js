const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { getVolumes, getAudioDeviceId } = require('../database/repositories/settings-repo');
const { earconSynth } = require('./earcon-synth');
const { audioSession } = require('./audio-session');

const ALL_KEYS_EXHAUSTED_MESSAGE = 'All API keys have reached their rate limit. Please wait a moment.';
const PRIMARY_VOICE = 'en-US-AndrewNeural';
const FALLBACK_VOICE = 'en-US-AvaNeural';

/**
 * Sanitizes plain text for smooth, natural Text-to-Speech synthesis.
 * Strips markdown formatting, code fences, citations, and converts math symbols to verbal words.
 * @param {string} text
 * @returns {string}
 */
function cleanTextForTTS(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    // Markdown formatting: bold and italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Markdown headers
    .replace(/^#{1,6}\s+/gm, '')
    // Code blocks & inline code
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    // Markdown links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Raw URLs and citation brackets [1], [2]
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[\d+\]/g, '')
    // LaTeX formulas and math blocks
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    // Leading list/bullet markers
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // Common math symbols to spoken English equivalents
    .replace(/\s*\+\s*/g, ' plus ')
    .replace(/\s*=\s*/g, ' equals ')
    .replace(/\s*%\s*/g, ' percent ')
    .replace(/√/g, ' square root of ')
    // Blockquotes
    .replace(/^>\s+/gm, '')
    // Stray formatting characters
    .replace(/[~#^_{}\\<>|]/g, ' ')
    // Collapse multiple whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits cleaned text into sentences based on punctuation.
 * @param {string} text
 * @returns {Array<string>}
 */
function splitSentences(text) {
  if (!text) return [];
  const rawMatches = text.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [text];
  const results = [];
  for (const m of rawMatches) {
    const trimmed = m.trim();
    if (trimmed.length > 0) {
      results.push(trimmed);
    }
  }
  return results;
}

/**
 * Groups sentences into synthesis chunks.
 * Sentence 0 is always standalone so narrator begins speaking in under 300ms.
 * Remaining sentences are grouped into manageable chunks (~120 chars).
 * @param {Array<string>} sentences
 * @returns {Array<string>}
 */
function groupSentences(sentences) {
  if (!sentences || sentences.length <= 1) return sentences;
  const groups = [sentences[0]];

  let currentGroup = '';
  for (let i = 1; i < sentences.length; i++) {
    const s = sentences[i];
    if (!currentGroup) {
      currentGroup = s;
    } else if (currentGroup.length + s.length < 120) {
      currentGroup += ` ${s}`;
    } else {
      groups.push(currentGroup);
      currentGroup = s;
    }
  }
  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}

class TTSEngine {
  constructor() {
    this.clientPool = [];
    this.activeVoice = PRIMARY_VOICE;
    this.lastAnswerBuffer = null;
    this.lastAnswerText = '';
    this.rateLimitFallbackBuffer = null;
    this.playbackDispatcher = null;
    this.isInitializing = false;
  }

  /**
   * Sets the playback dispatcher callback (bridged to Electron IPC).
   * @param {Function} dispatcher - (audioBuffer: Buffer, playbackRate: number, volume: number, sinkId: string, isFirstChunk: boolean) => void
   */
  setDispatcher(dispatcher) {
    this.playbackDispatcher = dispatcher;
  }

  /**
   * Initializes or returns the pre-warmed pool of MsEdgeTTS clients.
   * @returns {Promise<Array<MsEdgeTTS>>}
   */
  async initPool() {
    if (this.clientPool.length >= 2) {
      return this.clientPool;
    }

    try {
      const pool = [new MsEdgeTTS(), new MsEdgeTTS()];
      await Promise.all(
        pool.map((c) =>
          c.setMetadata(this.activeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        )
      );
      this.clientPool = pool;
    } catch (_err) {
      // Fallback voice if primary voice metadata fails
      try {
        this.activeVoice = FALLBACK_VOICE;
        const fallbackPool = [new MsEdgeTTS(), new MsEdgeTTS()];
        await Promise.all(
          fallbackPool.map((c) =>
            c.setMetadata(this.activeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
          )
        );
        this.clientPool = fallbackPool;
      } catch (_err2) {
        // Ignored
      }
    }

    return this.clientPool;
  }

  /**
   * Synthesizes a single chunk of text using a specific MsEdgeTTS client.
   * @param {MsEdgeTTS} client
   * @param {string} text
   * @param {Object} [options]
   * @returns {Promise<Buffer>}
   */
  async synthesizeChunk(client, text, options = {}) {
    if (!text || !text.trim()) {
      return Buffer.alloc(0);
    }

    const streamResult = client.toStream(text.trim(), options);
    const audioStream =
      streamResult && streamResult.audioStream ? streamResult.audioStream : streamResult;

    return new Promise((resolve, reject) => {
      const chunks = [];
      audioStream.on('data', (chunk) => chunks.push(chunk));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', (err) => reject(err));
    });
  }

  /**
   * Speaks the AI response text with ultra-low latency.
   * Chunks into sentences, starts playback of the first sentence immediately (< 300ms),
   * synthesizes remaining chunks concurrently, and caches full audio for replay.
   * @param {string} text
   * @param {number} [rate=1.0]
   * @returns {Promise<Buffer>}
   */
  async speakAnswer(text, rate = 1.0) {
    const cleanText = cleanTextForTTS(text);
    if (!cleanText) {
      return Buffer.alloc(0);
    }

    this.lastAnswerText = cleanText;
    audioSession.killActiveAudio();
    const currentGen = audioSession.getGeneration();

    try {
      const pool = await this.initPool();
      const client0 = pool[0] || new MsEdgeTTS();
      const sentences = splitSentences(cleanText);
      const groups = groupSentences(sentences);

      // Single short sentence: synthesize in one shot
      if (groups.length <= 1) {
        const buffer = await this.synthesizeChunk(client0, cleanText);
        if (audioSession.isCurrent(currentGen) && buffer && buffer.length > 0) {
          this.lastAnswerBuffer = buffer;
          this.dispatchAudio(buffer, rate, true);
        }
        return buffer;
      }

      // Multi-sentence answer: synthesize Chunk 0 first and stream immediately
      const client1 = pool[1] || client0;
      const chunkPromises = [];

      // Chunk 0 Promise
      const chunk0Promise = this.synthesizeChunk(client0, groups[0]).then((buf) => {
        if (audioSession.isCurrent(currentGen) && buf && buf.length > 0) {
          // Immediately dispatch first chunk so narrator begins speaking right away
          this.dispatchAudio(buf, rate, true);
        }
        return buf;
      });
      chunkPromises.push(chunk0Promise);

      // Remaining Chunks synthesized in parallel
      for (let i = 1; i < groups.length; i++) {
        const client = i % 2 === 0 ? client0 : client1;
        const groupText = groups[i];
        const nextPromise = this.synthesizeChunk(client, groupText).then((buf) => {
          if (audioSession.isCurrent(currentGen) && buf && buf.length > 0) {
            // Dispatch subsequent chunk to queue seamlessly in renderer Web Audio API
            this.dispatchAudio(buf, rate, false);
          }
          return buf;
        });
        chunkPromises.push(nextPromise);
      }

      const allBuffers = await Promise.all(chunkPromises);
      if (!audioSession.isCurrent(currentGen)) {
        return Buffer.alloc(0);
      }
      const combinedBuffer = Buffer.concat(allBuffers.filter((b) => b && b.length > 0));
      if (combinedBuffer.length > 0) {
        this.lastAnswerBuffer = combinedBuffer;
      }
      return combinedBuffer;
    } catch (err) {
      console.error('Error synthesizing speech in speakAnswer:', err);
      return Buffer.alloc(0);
    }
  }

  /**
   * Replays the most recent AI answer from RAM cache.
   * In Throw Mode (and Save Mode), the last answer is preserved in volatile memory
   * and only replaced when a new answer is generated.
   * @param {number} [speed=1.0] - 1.0 for normal speed, 0.75 for slow speed
   * @returns {boolean} Whether audio buffer was available and dispatched
   */
  replayLastAnswer(speed = 1.0) {
    if (!this.lastAnswerBuffer || this.lastAnswerBuffer.length === 0) {
      try {
        earconSynth.playDoubleLowTut();
      } catch (_e) {}
      return false;
    }

    audioSession.killActiveAudio();
    const playbackRate = speed === 0.75 ? 0.75 : 1.0;
    this.dispatchAudio(this.lastAnswerBuffer, playbackRate, true);
    return true;
  }

  /**
   * Plays the pre-synthesized or synthesized "All API keys exhausted" alert.
   */
  async speakRateLimitAlert() {
    audioSession.killActiveAudio();
    try {
      if (!this.rateLimitFallbackBuffer) {
        const pool = await this.initPool();
        const client = pool[0] || new MsEdgeTTS();
        this.rateLimitFallbackBuffer = await this.synthesizeChunk(client, ALL_KEYS_EXHAUSTED_MESSAGE);
      }
      this.dispatchAudio(this.rateLimitFallbackBuffer, 1.0, true);
    } catch (_err) {
      // Handled silently
    }
  }

  /**
   * Helper to dispatch audio playback to Renderer Web Audio API.
   * @param {Buffer} buffer
   * @param {number} rate
   * @param {boolean} [isFirstChunk=true]
   */
  dispatchAudio(buffer, rate = 1.0, isFirstChunk = true) {
    if (!buffer || buffer.length === 0) return;
    const { ttsVolume } = getVolumes();
    const sinkId = getAudioDeviceId();

    if (this.playbackDispatcher) {
      this.playbackDispatcher(buffer, rate, ttsVolume, sinkId, isFirstChunk);
    }
  }

  /**
   * Warm-ups the TTS engine and pre-synthesizes the rate limit alert in the background.
   */
  async warmUp() {
    if (this.isInitializing) return;
    this.isInitializing = true;
    try {
      const pool = await this.initPool();
      const client = pool[0] || new MsEdgeTTS();
      this.rateLimitFallbackBuffer = await this.synthesizeChunk(client, ALL_KEYS_EXHAUSTED_MESSAGE);
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
  cleanTextForTTS,
  splitSentences,
  groupSentences,
  ALL_KEYS_EXHAUSTED_MESSAGE,
};
