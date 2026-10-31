const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clipboard } = require('electron');
const { GoogleGenAI, Type } = require('@google/genai');
const { keyPool } = require('./key-pool');
const { memoryEngine } = require('./memory-engine');
const { ttsEngine } = require('../audio/tts-engine');
const { earconSynth } = require('../audio/earcon-synth');
const { companionCache } = require('../companion/companion-cache');
const {
  STANDARD_CHAT_SYSTEM_PROMPT,
  COMPANION_STEALTH_SYSTEM_PROMPT,
  getCompanionSystemPrompt,
} = require('./prompts');
const { addMessage } = require('../database/repositories/message-repo');
const {
  getAllConversations,
  getMostRecentConversation,
  getConversation,
  createConversation,
} = require('../database/repositories/conversation-repo');
const { getActiveModel, getOutputProfile } = require('../database/repositories/settings-repo');
const { getCapturesDirectory } = require('../database/sqlite-client');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const SUPPORTED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
];

/**
 * Strict JSON Schemas for each of the 5 Output Profiles.
 */
const COMPANION_SCHEMAS = {
  SHORT_ANSWER: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING },
      normal_text: { type: Type.STRING },
      paced_text: { type: Type.STRING },
    },
    required: ['type', 'normal_text', 'paced_text'],
  },
  MULTIPLE_CHOICE: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING },
      option_index: { type: Type.INTEGER },
      total_options: { type: Type.INTEGER },
      confidence: { type: Type.STRING },
    },
    required: ['type', 'option_index', 'total_options'],
  },
  ESSAY: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING },
      content: { type: Type.STRING },
    },
    required: ['type', 'content'],
  },
  PROGRAMMING: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING },
      language: { type: Type.STRING },
      content: { type: Type.STRING },
    },
    required: ['type', 'language', 'content'],
  },
  MATHEMATICS: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING },
      content: { type: Type.STRING },
    },
    required: ['type', 'content'],
  },
};

/**
 * Maps application reasoning level to Google GenAI thinkingConfig.
 * @param {'low'|'medium'|'high'} level
 * @returns {{ thinkingLevel: 'LOW'|'MEDIUM'|'HIGH' }}
 */
function resolveThinkingConfig(level) {
  const normalized = String(level || 'low').toLowerCase();
  switch (normalized) {
    case 'high':
      return { thinkingLevel: 'HIGH' };
    case 'medium':
      return { thinkingLevel: 'MEDIUM' };
    case 'low':
    default:
      return { thinkingLevel: 'LOW' };
  }
}

class GeminiService {
  constructor() {
    this.currentAbortController = null;
    this.onCompanionMessageCallback = null;
  }

  /**
   * Sets callback to notify main window in real-time when Companion saves messages to DB.
   * @param {(data: { conversationId: string, message: Object, isUser: boolean }) => void} callback
   */
  setOnCompanionMessage(callback) {
    this.onCompanionMessageCallback = callback;
  }

  /**
   * Aborts any currently running generateContent request.
   * @returns {boolean} Whether an active generation was aborted
   */
  stopActiveGeneration() {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
      return true;
    }
    return false;
  }

  /**
   * Processes a user chat message in Main Visible Workspace Mode.
   * @param {Object} params
   * @param {string} params.conversationId
   * @param {string} params.text
   * @param {Array<Buffer>} [params.images=[]]
   * @param {Array<string>} [params.attachmentPaths=[]]
   * @param {'low'|'medium'|'high'} [params.reasoningLevel]
   * @param {string} [params.model]
   * @returns {Promise<{ messageId: string, content: string }>}
   */
  async sendChatMessage({
    conversationId,
    text,
    images = [],
    attachmentPaths = [],
    reasoningLevel,
    model,
  }) {
    if (!conversationId) {
      const conv = getMostRecentConversation();
      conversationId = conv.id;
    }

    const conv = getConversation(conversationId);
    const activeReasoning = reasoningLevel || (conv ? conv.reasoning_level : 'low');

    const targetModel = model || getActiveModel() || DEFAULT_MODEL;

    // 1. Record user message in local SQLite database
    const userMsg = addMessage({
      conversation_id: conversationId,
      role: 'user',
      content: text || '',
      attachments_json: attachmentPaths,
    });

    // 2. Assemble optimized Three-Tier Context Payload
    const { contents, systemInstruction } = memoryEngine.buildContextPayload(
      conversationId,
      { text, images },
      STANDARD_CHAT_SYSTEM_PROMPT
    );

    const config = { systemInstruction };
    if (targetModel.includes('3.8-flash')) {
      config.thinkingConfig = resolveThinkingConfig(activeReasoning);
    }

    const controller = new AbortController();
    this.currentAbortController = controller;

    try {
      // 3. Dispatch to Gemini with Key Rotation & Failover
      const answerText = await keyPool.executeWithRetry(async (apiKey) => {
        if (controller.signal.aborted) {
          throw new Error('Generation stopped by user.');
        }

        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: targetModel,
          contents,
          config,
        });

        if (controller.signal.aborted) {
          throw new Error('Generation stopped by user.');
        }

        return response && response.text ? response.text : '';
      });

      if (controller.signal.aborted) {
        throw new Error('Generation stopped by user.');
      }

    // 4. Save model response in database (safeguarded against deleted or stale conversations)
    let targetConvId = conversationId;
    const convCheck = getConversation(targetConvId);
    if (!convCheck) {
      const fallback = getMostRecentConversation();
      targetConvId = fallback ? fallback.id : conversationId;
    }

    const modelMsg = addMessage({
      conversation_id: targetConvId,
      role: 'model',
      content: answerText,
    });

    // 5. Asynchronously trigger Tier 3 Image Pruning & Tier 1 Rolling Summary
    if (images.length > 0 && userMsg) {
      memoryEngine
        .extractAndSaveImageContext(keyPool, targetConvId, userMsg.id, images)
        .catch(() => {});
    }

    memoryEngine
      .triggerRollingSummaryIfNeeded(keyPool, targetConvId)
      .catch(() => {});

      return {
        messageId: modelMsg ? modelMsg.id : null,
        content: answerText,
      };
    } finally {
      if (this.currentAbortController === controller) {
        this.currentAbortController = null;
      }
    }
  }

  /**
   * Processes a staged payload in Stealth Companion Mode.
   * Directs output to TTS engine and handles Save vs. Throw database semantics.
   * @param {Object} params
   * @param {Array<Buffer>} params.images - Array of screenshot JPEG buffers
   * @param {string} params.text - Transcribed voice instruction or text
   * @param {'save'|'throw'} [params.subMode='save'] - Save to DB vs Volatile RAM
   * @param {'low'|'medium'|'high'} [params.reasoningLevel='low']
   * @param {string} [params.conversationId]
   * @param {string} [params.model]
   * @param {'SHORT_ANSWER'|'MULTIPLE_CHOICE'|'ESSAY'} [params.outputProfile]
   * @returns {Promise<{ content: string, conversationId: string|null, profile: string }>}
   */
  async processCompanionPayload({
    images = [],
    text = '',
    subMode = 'save',
    reasoningLevel = 'low',
    conversationId = null,
    model,
    outputProfile = null,
  }) {
    let targetConversationId = null;
    let userMsg = null;
    const savedAttachmentPaths = [];

    if (subMode === 'save') {
      targetConversationId = conversationId;
      if (!targetConversationId) {
        const recent = getMostRecentConversation();
        targetConversationId = recent ? recent.id : null;
      }
      if (!targetConversationId) {
        const newConv = createConversation({ title: 'Companion Session' });
        targetConversationId = newConv.id;
      }

      // Persist screenshot buffers to disk in the captures folder
      if (images && images.length > 0) {
        const capturesDir = getCapturesDirectory();
        for (let i = 0; i < images.length; i++) {
          const imgBuffer = images[i];
          if (Buffer.isBuffer(imgBuffer) && imgBuffer.length > 0) {
            const fileName = `capture_${Date.now()}_${i}_${crypto.randomBytes(4).toString('hex')}.jpg`;
            const filePath = path.join(capturesDir, fileName);
            try {
              fs.writeFileSync(filePath, imgBuffer);
              savedAttachmentPaths.push(filePath);
            } catch (err) {
              console.error('Failed to save companion screenshot to disk:', err);
            }
          }
        }
      }

      // Persist user action in Save Mode with attachments and speech-to-text
      const userContent = text ? text.trim() : (savedAttachmentPaths.length > 0 ? '' : '');
      userMsg = addMessage({
        conversation_id: targetConversationId,
        role: 'user',
        content: userContent,
        attachments_json: savedAttachmentPaths.length > 0 ? savedAttachmentPaths : null,
      });

      if (this.onCompanionMessageCallback && userMsg) {
        this.onCompanionMessageCallback({
          conversationId: targetConversationId,
          message: userMsg,
          isUser: true,
        });
      }
    }

    const targetModel = model || getActiveModel() || DEFAULT_MODEL;
    const targetProfile = outputProfile || getOutputProfile();

    // Assemble payload with Profile-Specific System Prompt
    const systemInstruction = getCompanionSystemPrompt(targetProfile);
    const { contents } = memoryEngine.buildContextPayload(
      subMode === 'save' ? targetConversationId : null,
      { text, images },
      systemInstruction
    );

    const config = {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: COMPANION_SCHEMAS[targetProfile] || COMPANION_SCHEMAS.SHORT_ANSWER,
    };
    if (targetModel.includes('3.8-flash')) {
      config.thinkingConfig = resolveThinkingConfig(reasoningLevel);
    }

    // Call Gemini Model
    const rawResponse = await keyPool.executeWithRetry(async (apiKey) => {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: targetModel,
        contents,
        config,
      });

      return response && response.text ? response.text : '';
    });

    // 1. Ready feedback: Play 2x tut ONLY for Short Answer, Essay, Programming, and Mathematics (disabled for Multiple Choice)
    if (targetProfile !== 'MULTIPLE_CHOICE') {
      earconSynth.playDoubleShortTut();
    }

    // 2. Parse structured JSON adhering to Output Profile schema with automated repair fallback
    const parsed = this._parseCompanionJson(rawResponse, targetProfile);
    let displayText = '';

    // 3. Profile-specific execution
    if (targetProfile === 'MULTIPLE_CHOICE') {
      const optionIndex = Math.max(1, parseInt(parsed.option_index, 10) || 1);
      const totalOptions = parseInt(parsed.total_options, 10) || 4;
      const confidence = String(parsed.confidence || 'high');

      companionCache.setLastAnswer('MULTIPLE_CHOICE', {
        option_index: optionIndex,
        total_options: totalOptions,
        confidence,
      });

      // Play N consecutive 880 Hz tut tones directly without 2x ready tut
      earconSynth.playNTuts(optionIndex, { durationMs: 90, gapMs: 70 });

      const letter = String.fromCharCode(64 + Math.min(26, optionIndex));
      displayText = `Option ${letter} (${optionIndex} of ${totalOptions})`;
    } else if (targetProfile === 'PROGRAMMING') {
      const content = this._stripCodeFences(String(parsed.content || '')).trim();
      const language = String(parsed.language || 'text').trim();
      companionCache.setLastAnswer('PROGRAMMING', { content, language });

      // Automatically copy directly into OS Clipboard
      try {
        clipboard.writeText(content);
      } catch (clipErr) {
        console.error('Failed to copy programming code to clipboard:', clipErr);
      }

      displayText = content;
    } else if (targetProfile === 'MATHEMATICS') {
      const content = this._stripCodeFences(String(parsed.content || '')).trim();
      companionCache.setLastAnswer('MATHEMATICS', { content });

      // Automatically copy directly into OS Clipboard
      try {
        clipboard.writeText(content);
      } catch (clipErr) {
        console.error('Failed to copy mathematics content to clipboard:', clipErr);
      }

      displayText = content;
    } else if (targetProfile === 'ESSAY') {
      const content = this._stripCodeFences(String(parsed.content || '')).replace(/[()]/g, '').trim();
      companionCache.setLastAnswer('ESSAY', { content });

      // Automatically copy directly into OS Clipboard
      try {
        clipboard.writeText(content);
      } catch (clipErr) {
        console.error('Failed to copy essay to clipboard:', clipErr);
      }

      displayText = content;
    } else {
      // SHORT_ANSWER (Default)
      const normalText = this._stripCodeFences(String(parsed.normal_text || '')).replace(/[()]/g, '').trim();
      const pacedText = String(parsed.paced_text || normalText).replace(/[()]/g, '').trim();

      companionCache.setLastAnswer('SHORT_ANSWER', {
        normal_text: normalText,
        paced_text: pacedText,
      });

      if (normalText) {
        ttsEngine.speakAnswer(normalText, 1.0).catch((err) => {
          console.error('Error during companion speakAnswer:', err);
        });
      }

      displayText = normalText;
    }

    // 4. If Save Mode, persist model answer and trigger background summarization concurrently
    if (subMode === 'save' && targetConversationId) {
      let targetConvId = targetConversationId;
      if (!getConversation(targetConvId)) {
        const fallback = getMostRecentConversation();
        targetConvId = fallback ? fallback.id : targetConversationId;
      }

      const modelMsg = addMessage({
        conversation_id: targetConvId,
        role: 'model',
        content: displayText || rawResponse,
      });

      if (this.onCompanionMessageCallback && modelMsg) {
        this.onCompanionMessageCallback({
          conversationId: targetConvId,
          message: modelMsg,
          isUser: false,
        });
      }

      if (images.length > 0 && userMsg) {
        memoryEngine
          .extractAndSaveImageContext(keyPool, targetConvId, userMsg.id, images)
          .catch(() => {});
      }

      memoryEngine
        .triggerRollingSummaryIfNeeded(keyPool, targetConvId)
        .catch(() => {});
    }

    return {
      content: displayText || rawResponse,
      conversationId: subMode === 'save' ? targetConversationId : null,
      profile: targetProfile,
    };
  }

  /**
   * Strips markdown code block fences if present.
   * @param {string} str
   * @returns {string}
   */
  _stripCodeFences(str) {
    if (!str) return '';
    let res = String(str).trim();
    if (res.startsWith('```')) {
      res = res.replace(/^```[a-zA-Z0-9_-]*\r?\n?/, '');
    }
    if (res.endsWith('```')) {
      res = res.replace(/\r?\n?```$/, '');
    }
    return res.trim();
  }

  /**
   * Safely parses structured JSON returned by Gemini according to profile schema.
   * Robust against unescaped markdown code fences, unescaped quotes in code, and malformed JSON.
   * @param {string} rawText
   * @param {'SHORT_ANSWER'|'MULTIPLE_CHOICE'|'ESSAY'|'PROGRAMMING'|'MATHEMATICS'} profile
   * @returns {Object}
   */
  _parseCompanionJson(rawText, profile) {
    let clean = String(rawText || '').trim();
    if (clean.startsWith('```json')) {
      clean = clean.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    } else if (clean.startsWith('```')) {
      clean = clean.replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/```\s*$/, '').trim();
    }

    // Attempt 1: Direct JSON parse
    try {
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (_err) {
      // Direct parse failed, proceed to automated repair fallback
    }

    // Attempt 2: Automated extraction for text-based profiles (ESSAY, PROGRAMMING, MATHEMATICS)
    if (profile === 'ESSAY' || profile === 'PROGRAMMING' || profile === 'MATHEMATICS') {
      const contentMatch = clean.match(/"content"\s*:\s*"([\s\S]*)/i);
      if (contentMatch) {
        let remaining = contentMatch[1];
        // Strip trailing quotes, whitespace, and closing braces
        remaining = remaining.replace(/"\s*\}?\s*$/, '');
        // Unescape standard JSON string escapes
        let extracted = remaining
          .replace(/\\"/g, '"')
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\');

        extracted = this._stripCodeFences(extracted);

        let lang = 'text';
        const langMatch = clean.match(/"language"\s*:\s*"([^"\r\n]+)"/i);
        if (langMatch) lang = langMatch[1];

        if (profile === 'PROGRAMMING') {
          return { type: 'programming', language: lang, content: extracted };
        }
        if (profile === 'MATHEMATICS') {
          return { type: 'mathematics', content: extracted };
        }
        return { type: 'essay', content: extracted };
      }

      // If no "content" key found at all, treat the raw response as the payload
      const direct = this._stripCodeFences(clean);
      if (profile === 'PROGRAMMING') {
        return { type: 'programming', language: 'text', content: direct };
      }
      if (profile === 'MATHEMATICS') {
        return { type: 'mathematics', content: direct };
      }
      return { type: 'essay', content: direct };
    }

    // Attempt 3: MULTIPLE_CHOICE fallback
    if (profile === 'MULTIPLE_CHOICE') {
      const match = clean.match(/option[_\s]*index"?\s*:\s*(\d+)/i) ||
        clean.match(/option\s*([A-Ea-e])/i) ||
        clean.match(/\b([1-5])\b/);
      let idx = 1;
      if (match) {
        if (/\d/.test(match[1])) {
          idx = parseInt(match[1], 10);
        } else {
          idx = match[1].toUpperCase().charCodeAt(0) - 64;
        }
      }
      const totMatch = clean.match(/total[_\s]*options"?\s*:\s*(\d+)/i);
      const tot = totMatch ? parseInt(totMatch[1], 10) : 4;
      return { type: 'mcq', option_index: idx, total_options: tot, confidence: 'high' };
    }

    // Attempt 4: SHORT_ANSWER fallback
    const normMatch = clean.match(/"normal_text"\s*:\s*"([\s\S]*?)(?:",\s*"paced_text"|"\s*\})/i);
    let normal = normMatch ? normMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : clean;
    normal = this._stripCodeFences(normal).replace(/[()]/g, '').trim();
    const words = normal.replace(/[^\w\s]/g, '').trim().split(/\s+/).filter(Boolean);
    const paced = words.length > 0 ? words.join('. ') + '.' : normal;
    return { type: 'short_answer', normal_text: normal, paced_text: paced };
  }
}

const geminiService = new GeminiService();

module.exports = {
  geminiService,
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  resolveThinkingConfig,
};
