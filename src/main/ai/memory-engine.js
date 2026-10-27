const { getConversation, updateRollingSummary } = require('../database/repositories/conversation-repo');
const { getMessages, updateExtractedImageContext } = require('../database/repositories/message-repo');
const { ROLLING_SUMMARY_SYSTEM_PROMPT, IMAGE_SUMMARY_SYSTEM_PROMPT } = require('./prompts');

const SLIDING_WINDOW_TURNS = 8;
const SLIDING_WINDOW_MESSAGES = SLIDING_WINDOW_TURNS * 2; // 16 messages

class MemoryEngine {
  /**
   * Constructs the optimized three-tier payload for Gemini 3.8 Flash.
   * @param {string|null} conversationId - Active conversation ID (null if in Throw mode)
   * @param {Object} currentTurn
   * @param {string} [currentTurn.text] - New user text / voice prompt
   * @param {Array<Buffer>} [currentTurn.images] - New image buffers submitted in this turn
   * @param {string} systemInstruction - System prompt (standard or companion stealth)
   * @returns {{ contents: Array<Object>, systemInstruction: string }}
   */
  buildContextPayload(conversationId, currentTurn, systemInstruction) {
    const contents = [];

    // If no conversationId (e.g. Companion Throw Mode), zero memory / single-turn only
    if (!conversationId) {
      const userParts = [];
      if (currentTurn.images && currentTurn.images.length > 0) {
        for (const imgBuffer of currentTurn.images) {
          userParts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: imgBuffer.toString('base64'),
            },
          });
        }
      }
      if (currentTurn.text && currentTurn.text.trim()) {
        userParts.push({ text: currentTurn.text.trim() });
      } else if (userParts.length === 0) {
        userParts.push({ text: 'Please analyze the submitted visual input.' });
      }

      contents.push({ role: 'user', parts: userParts });
      return { contents, systemInstruction };
    }

    const conversation = getConversation(conversationId);
    const allMessages = getMessages(conversationId);

    // Tier 1: Asynchronous Rolling Summary of turns older than the sliding window
    let tier1Summary = conversation ? conversation.rolling_summary : null;

    // Tier 2: Sliding Window of the last 8 turns (16 messages)
    const recentMessages = allMessages.slice(-SLIDING_WINDOW_MESSAGES);

    // Build the messages payload
    for (let i = 0; i < recentMessages.length; i++) {
      const msg = recentMessages[i];
      const role = msg.role === 'model' ? 'model' : 'user';
      const parts = [];

      // Tier 3: Multimodal Image Pruning
      // For historical user turns, strip heavy base64 image buffers and substitute concise extracted context
      if (role === 'user' && msg.extracted_image_context) {
        parts.push({
          text: `[Visual context from previously attached image: ${msg.extracted_image_context}]\n${msg.content || ''}`,
        });
      } else {
        parts.push({ text: msg.content || '' });
      }

      contents.push({ role, parts });
    }

    // Assemble current turn parts
    const currentParts = [];
    if (currentTurn.images && currentTurn.images.length > 0) {
      for (const imgBuffer of currentTurn.images) {
        currentParts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: imgBuffer.toString('base64'),
          },
        });
      }
    }
    if (currentTurn.text && currentTurn.text.trim()) {
      currentParts.push({ text: currentTurn.text.trim() });
    } else if (currentParts.length === 0) {
      currentParts.push({ text: 'Please analyze the submitted visual input.' });
    }

    contents.push({ role: 'user', parts: currentParts });

    // Inject Tier 1 Rolling Summary into system instructions or as introductory context
    let finalSystemInstruction = systemInstruction;
    if (tier1Summary && tier1Summary.trim()) {
      finalSystemInstruction = `${systemInstruction}\n\n[Active Conversation Background Summary]:\n${tier1Summary.trim()}`;
    }

    return { contents, systemInstruction: finalSystemInstruction };
  }

  /**
   * Generates a concise textual summary of an attached image to enable Tier 3 image pruning.
   * @param {import('./key-pool').KeyPoolManager} keyPool
   * @param {string} conversationId
   * @param {string} messageId
   * @param {Array<Buffer>} imageBuffers
   */
  async extractAndSaveImageContext(keyPool, conversationId, messageId, imageBuffers) {
    if (!imageBuffers || imageBuffers.length === 0 || !messageId) {
      return;
    }

    try {
      const { GoogleGenAI } = require('@google/genai');

      await keyPool.executeWithRetry(async (apiKey) => {
        const ai = new GoogleGenAI({ apiKey });
        const parts = [];

        for (const buf of imageBuffers) {
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: buf.toString('base64'),
            },
          });
        }
        parts.push({ text: 'Provide a dense factual summary of what is visually shown.' });

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [{ role: 'user', parts }],
          config: {
            systemInstruction: IMAGE_SUMMARY_SYSTEM_PROMPT,
            temperature: 0.2,
          },
        });

        const textSummary = response && response.text ? response.text.trim() : '';
        if (textSummary) {
          updateExtractedImageContext(messageId, textSummary);
        }
      });
    } catch (_err) {
      // Image pruning extraction failure should not disrupt conversation flow
    }
  }

  /**
   * Triggers asynchronous rolling summary creation if the message history exceeds 8 turns.
   * @param {import('./key-pool').KeyPoolManager} keyPool
   * @param {string} conversationId
   */
  async triggerRollingSummaryIfNeeded(keyPool, conversationId) {
    if (!conversationId) return;

    try {
      const allMessages = getMessages(conversationId);
      if (allMessages.length <= SLIDING_WINDOW_MESSAGES) {
        return;
      }

      // Older turns that will be summarized
      const olderMessages = allMessages.slice(0, allMessages.length - SLIDING_WINDOW_MESSAGES);
      const conversation = getConversation(conversationId);
      const previousSummary = conversation ? conversation.rolling_summary : '';

      const transcript = olderMessages
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');

      const { GoogleGenAI } = require('@google/genai');

      await keyPool.executeWithRetry(async (apiKey) => {
        const ai = new GoogleGenAI({ apiKey });
        const userPrompt = previousSummary
          ? `Previous Summary:\n${previousSummary}\n\nNewer turns to incorporate:\n${transcript}`
          : `Transcript to summarize:\n${transcript}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: ROLLING_SUMMARY_SYSTEM_PROMPT,
            temperature: 0.2,
          },
        });

        const newSummary = response && response.text ? response.text.trim() : '';
        if (newSummary) {
          updateRollingSummary(conversationId, newSummary);
        }
      });
    } catch (_err) {
      // Rolling summary runs silently in the background
    }
  }
}

const memoryEngine = new MemoryEngine();

module.exports = {
  memoryEngine,
  SLIDING_WINDOW_TURNS,
  SLIDING_WINDOW_MESSAGES,
};
