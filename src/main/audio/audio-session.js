/**
 * Universal Audio Playback Session Manager.
 * Maintains a single shared playback session reference across TTS speech and Tut earcons.
 * Enables immediate universal audio interruption and hard stop.
 */
class AudioPlaybackSession {
  constructor() {
    this.generation = 0;
    this.stopDispatcher = null;
  }

  /**
   * Registers callback to dispatch audio stop event to Renderer Web Audio API.
   * @param {Function} dispatcher
   */
  setStopDispatcher(dispatcher) {
    this.stopDispatcher = dispatcher;
  }

  /**
   * Immediately terminates active audio playback (TTS or Tut earcon sequences).
   * Increments session generation so background streaming chunks are discarded.
   */
  killActiveAudio() {
    this.generation++;
    if (this.stopDispatcher) {
      try {
        this.stopDispatcher();
      } catch (_err) {
        // Ignored
      }
    }
  }

  /**
   * Returns current session generation token.
   * @returns {number}
   */
  getGeneration() {
    return this.generation;
  }

  /**
   * Checks whether the given generation token matches the active session.
   * @param {number} gen
   * @returns {boolean}
   */
  isCurrent(gen) {
    return this.generation === gen;
  }
}

const audioSession = new AudioPlaybackSession();

module.exports = {
  audioSession,
  AudioPlaybackSession,
};

