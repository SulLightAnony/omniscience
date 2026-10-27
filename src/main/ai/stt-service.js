const { GoogleGenAI } = require('@google/genai');
const { keyPool } = require('./key-pool');
const { STT_SYSTEM_PROMPT } = require('./prompts');

/**
 * Detects audio MIME type based on buffer magic bytes.
 * @param {Buffer} buffer
 * @returns {string}
 */
function detectAudioMimeType(buffer) {
  if (!buffer || buffer.length < 4) {
    return 'audio/webm';
  }

  // RIFF header -> audio/wav
  if (buffer.toString('ascii', 0, 4) === 'RIFF') {
    return 'audio/wav';
  }

  // Matroska / WebM EBML ID (0x1A 0x45 0xDF 0xA3)
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'audio/webm';
  }

  // MP3 ID3 header or sync word
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return 'audio/mp3';
  }

  // Default fallback
  return 'audio/webm';
}

/**
 * Transcribes an in-memory audio recording into English text using Gemini 3.8 Flash.
 * @param {Buffer} audioBuffer
 * @returns {Promise<string>}
 */
async function transcribeAudio(audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) {
    return '';
  }

  const mimeType = detectAudioMimeType(audioBuffer);

  return keyPool.executeWithRetry(async (apiKey) => {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBuffer.toString('base64'),
              },
            },
            {
              text: 'Transcribe the spoken words from this audio recording verbatim in English.',
            },
          ],
        },
      ],
      config: {
        systemInstruction: STT_SYSTEM_PROMPT,
        temperature: 0.0,
      },
    });

    const transcribedText = response && response.text ? response.text.trim() : '';
    return transcribedText;
  });
}

module.exports = {
  transcribeAudio,
  detectAudioMimeType,
};
