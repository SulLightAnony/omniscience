/**
 * Volatile RAM Cache for Companion Answers.
 * Retains the latest generated answer across 5 profiles (Short Answer, MCQ, Essay, Programming, Mathematics)
 * for replaying audio, re-copying to clipboard, and driving the Auto-Typing engine.
 */
class CompanionCache {
  constructor() {
    this.lastProfile = null;
    this.shortAnswer = null;  // { normal_text: string, paced_text: string }
    this.mcq = null;          // { option_index: number, total_options: number, confidence: string }
    this.essay = null;        // { content: string }
    this.programming = null;  // { content: string, language: string }
    this.mathematics = null;  // { content: string }
  }

  /**
   * Sets the latest generated answer.
   * @param {'SHORT_ANSWER'|'MULTIPLE_CHOICE'|'ESSAY'|'PROGRAMMING'|'MATHEMATICS'} profile
   * @param {Object} data
   */
  setLastAnswer(profile, data) {
    this.lastProfile = profile;
    if (profile === 'SHORT_ANSWER') {
      this.shortAnswer = {
        normal_text: String(data.normal_text || '').trim(),
        paced_text: String(data.paced_text || data.normal_text || '').trim(),
      };
    } else if (profile === 'MULTIPLE_CHOICE') {
      const idx = parseInt(data.option_index, 10);
      this.mcq = {
        option_index: Number.isInteger(idx) && idx > 0 ? idx : 1,
        total_options: parseInt(data.total_options, 10) || 4,
        confidence: String(data.confidence || 'high'),
      };
    } else if (profile === 'ESSAY') {
      this.essay = {
        content: String(data.content || '').trim(),
      };
    } else if (profile === 'PROGRAMMING') {
      this.programming = {
        content: String(data.content || '').trim(),
        language: String(data.language || 'text').trim(),
      };
    } else if (profile === 'MATHEMATICS') {
      this.mathematics = {
        content: String(data.content || '').trim(),
      };
    }
  }

  getLastProfile() {
    return this.lastProfile;
  }

  getShortAnswer() {
    return this.shortAnswer;
  }

  getMcq() {
    return this.mcq;
  }

  getEssay() {
    return this.essay;
  }

  getProgramming() {
    return this.programming;
  }

  getMathematics() {
    return this.mathematics;
  }

  /**
   * Returns text content suitable for clipboard injection or auto-typing for text-based profiles.
   * @param {'ESSAY'|'PROGRAMMING'|'MATHEMATICS'} profile
   * @returns {string}
   */
  getTextContent(profile) {
    if (profile === 'PROGRAMMING') return (this.programming && this.programming.content) || '';
    if (profile === 'MATHEMATICS') return (this.mathematics && this.mathematics.content) || '';
    return (this.essay && this.essay.content) || '';
  }

  hasAnswerForProfile(profile) {
    if (profile === 'SHORT_ANSWER') return Boolean(this.shortAnswer && this.shortAnswer.normal_text);
    if (profile === 'MULTIPLE_CHOICE') return Boolean(this.mcq && this.mcq.option_index);
    if (profile === 'ESSAY') return Boolean(this.essay && this.essay.content);
    if (profile === 'PROGRAMMING') return Boolean(this.programming && this.programming.content);
    if (profile === 'MATHEMATICS') return Boolean(this.mathematics && this.mathematics.content);
    return false;
  }

  clear() {
    this.lastProfile = null;
    this.shortAnswer = null;
    this.mcq = null;
    this.essay = null;
    this.programming = null;
    this.mathematics = null;
  }
}

const companionCache = new CompanionCache();

module.exports = {
  companionCache,
  CompanionCache,
};

