const { GoogleGenAI } = require('@google/genai');
const { keyPool } = require('./key-pool');
const { memoryEngine } = require('./memory-engine');
const { ttsEngine } = require('../audio/tts-engine');
const {
  STANDARD_CHAT_SYSTEM_PROMPT,
  COMPANION_STEALTH_SYSTEM_PROMPT,
} = require('./prompts');
const { addMessage } = require('../database/repositories/message-repo');
const {
  getMostRecentConversation,
  getConversation,
} = require('../database/repositories/conversation-repo');
const { getActiveModel } = require('../database/repositories/settings-repo');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const SUPPORTED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
];

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
   * @returns {Promise<{ content: string, conversationId: string|null }>}
   */
  async processCompanionPayload({
    images = [],
    text = '',
    subMode = 'save',
    reasoningLevel = 'low',
    conversationId = null,
    model,
  }) {
    let targetConversationId = null;
    let userMsg = null;

    if (subMode === 'save') {
      targetConversationId = conversationId;
      if (!targetConversationId) {
        const recent = getMostRecentConversation();
        targetConversationId = recent.id;
      }

      // Persist user action in Save Mode
      userMsg = addMessage({
        conversation_id: targetConversationId,
        role: 'user',
        content: text || (images.length > 0 ? '[Companion Staged Screenshot Capture]' : ''),
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

    // Assemble payload (Throw mode sets targetConversationId to null -> zero memory)
    const { contents, systemInstruction } = memoryEngine.buildContextPayload(
      subMode === 'save' ? targetConversationId : null,
      { text, images },
      COMPANION_STEALTH_SYSTEM_PROMPT
    );

    const config = { systemInstruction };
    if (targetModel.includes('3.8-flash')) {
      config.thinkingConfig = resolveThinkingConfig(reasoningLevel);
    }

    // Call Gemini Model
    const answerText = await keyPool.executeWithRetry(async (apiKey) => {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: targetModel,
        contents,
        config,
      });

      return response && response.text ? response.text : '';
    });

    // If Save Mode, persist model answer and trigger background summarization
    if (subMode === 'save' && targetConversationId) {
      let targetConvId = targetConversationId;
      if (!getConversation(targetConvId)) {
        const fallback = getMostRecentConversation();
        targetConvId = fallback ? fallback.id : targetConversationId;
      }

      const modelMsg = addMessage({
        conversation_id: targetConvId,
        role: 'model',
        content: answerText,
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

    // Synthesize neural speech and speak answer directly through configured audio sink
    if (answerText) {
      ttsEngine.speakAnswer(answerText).catch(() => {});
    }

    return {
      content: answerText,
      conversationId: subMode === 'save' ? targetConversationId : null,
    };
  }
}

const geminiService = new GeminiService();

module.exports = {
  geminiService,
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  resolveThinkingConfig,
};
