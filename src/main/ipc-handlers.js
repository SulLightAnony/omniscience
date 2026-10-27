const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  getAllConversations,
  getConversation,
  createConversation,
  renameConversation,
  deleteConversation,
  getMostRecentConversation,
} = require('./database/repositories/conversation-repo');
const { getMessages } = require('./database/repositories/message-repo');
const {
  getAllSettings,
  updateSettings,
  setAudioDeviceId,
  setVolumes,
  getActiveModel,
  setActiveModel,
} = require('./database/repositories/settings-repo');
const { keyPool } = require('./ai/key-pool');
const { geminiService, SUPPORTED_MODELS } = require('./ai/gemini-service');
const { stateMachine } = require('./companion/state-machine');
const { stagingBuffer } = require('./companion/staging-buffer');
const { earconSynth } = require('./audio/earcon-synth');
const { ttsEngine } = require('./audio/tts-engine');

let activeVoiceResolver = null;

/**
 * Registers all IPC handlers and binds audio/voice dispatchers to the main window.
 * @param {import('electron').BrowserWindow} mainWindow
 * @param {import('./companion/hook-manager').HookManager} hookManager
 */
function registerIpcHandlers(mainWindow, hookManager) {
  // Bind earcon audio synthesizer dispatcher to Renderer Web Audio API
  earconSynth.setDispatcher((wavBuffer, sinkId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:play-earcon-wav', {
        buffer: wavBuffer,
        sinkId,
      });
    }
  });

  // Bind TTS neural speech dispatcher to Renderer Web Audio API
  ttsEngine.setDispatcher((audioBuffer, playbackRate, volume, sinkId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:play-tts-buffer', {
        buffer: audioBuffer,
        playbackRate,
        volume,
        sinkId,
      });
    }
  });

  // Bind push-to-talk microphone recording via Renderer MediaRecorder
  hookManager.setVoiceRecordingHandler({
    start: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice:record-start');
      }
    },
    stop: () => {
      return new Promise((resolve) => {
        activeVoiceResolver = resolve;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('voice:record-stop');
        } else {
          resolve(Buffer.alloc(0));
        }

        // Safety timeout in case renderer fails to respond
        setTimeout(() => {
          if (activeVoiceResolver === resolve) {
            activeVoiceResolver = null;
            resolve(Buffer.alloc(0));
          }
        }, 5000);
      });
    },
  });

  // Renderer returns captured microphone audio buffer
  ipcMain.on('voice:recorded-buffer', (_event, bufferArray) => {
    if (activeVoiceResolver) {
      const resolver = activeVoiceResolver;
      activeVoiceResolver = null;
      const buf = Buffer.isBuffer(bufferArray) ? bufferArray : Buffer.from(bufferArray);
      resolver(buf);
    }
  });

  // State machine updates -> push to renderer
  stateMachine.on('change', (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('companion:status-changed', snapshot);
    }
  });

  stagingBuffer.on('changed', (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('companion:staging-changed', snapshot);
    }
  });

  // ---------------- CONVERSATIONS ----------------
  ipcMain.handle('conversations:list', async () => {
    return getAllConversations();
  });

  ipcMain.handle('conversations:get', async (_e, id) => {
    return getConversation(id);
  });

  ipcMain.handle('conversations:create', async (_e, { title, reasoning_level }) => {
    return createConversation({ title, reasoning_level });
  });

  ipcMain.handle('conversations:rename', async (_e, { id, title }) => {
    return renameConversation(id, title);
  });

  ipcMain.handle('conversations:delete', async (_e, id) => {
    return deleteConversation(id);
  });

  ipcMain.handle('conversations:getRecent', async () => {
    return getMostRecentConversation();
  });

  // ---------------- MESSAGES ----------------
  ipcMain.handle('messages:list', async (_e, conversationId) => {
    return getMessages(conversationId);
  });

  ipcMain.handle('messages:send', async (_e, { conversationId, text, imagePaths, reasoningLevel, model }) => {
    const images = [];
    const paths = Array.isArray(imagePaths) ? imagePaths : [];

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          images.push(fs.readFileSync(p));
        }
      } catch (_err) {
        // Skip unreadable files
      }
    }

    return geminiService.sendChatMessage({
      conversationId,
      text,
      images,
      attachmentPaths: paths,
      reasoningLevel,
      model,
    });
  });

  ipcMain.handle('messages:stop', async () => {
    return geminiService.stopActiveGeneration();
  });

  // Model change from global keyboard shortcut -> push to renderer
  hookManager.setModelChangeDispatcher((newModel) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('model:changed', newModel);
    }
  });

  // ---------------- MODELS ----------------
  ipcMain.handle('models:list', async () => {
    return SUPPORTED_MODELS;
  });

  ipcMain.handle('models:getActive', async () => {
    return getActiveModel();
  });

  ipcMain.handle('models:setActive', async (_e, model) => {
    setActiveModel(model);
    return getActiveModel();
  });

  // ---------------- SETTINGS & KEY POOL ----------------
  ipcMain.handle('settings:get', async () => {
    return getAllSettings();
  });

  ipcMain.handle('settings:update', async (_e, updates) => {
    return updateSettings(updates);
  });

  ipcMain.handle('keys:status', async () => {
    return keyPool.getStatus();
  });

  ipcMain.handle('keys:add', async (_e, key) => {
    keyPool.addKey(key);
    return keyPool.getStatus();
  });

  ipcMain.handle('keys:remove', async (_e, identifier) => {
    keyPool.removeKey(identifier);
    return keyPool.getStatus();
  });

  ipcMain.handle('audio:setDevice', async (_e, deviceId) => {
    setAudioDeviceId(deviceId);
    return true;
  });

  ipcMain.handle('audio:setVolumes', async (_e, { earconVolume, ttsVolume }) => {
    setVolumes({ earconVolume, ttsVolume });
    return true;
  });

  ipcMain.handle('audio:replay', async (_e, speed) => {
    return ttsEngine.replayLastAnswer(speed || 1.0);
  });

  ipcMain.handle('audio:playEarcon', async (_e, pattern) => {
    earconSynth.play(pattern);
    return true;
  });

  // ---------------- COMPANION STATE ----------------
  ipcMain.handle('companion:status', async () => {
    return {
      ...stateMachine.getSnapshot(),
      staging: stagingBuffer.getSnapshot(),
    };
  });

  ipcMain.handle('companion:setArmed', async (_e, armed) => {
    stateMachine.setArmed(armed);
    return stateMachine.getSnapshot();
  });

  ipcMain.handle('companion:setSubMode', async (_e, mode) => {
    stateMachine.setSubMode(mode);
    return stateMachine.getSnapshot();
  });

  ipcMain.handle('companion:setReasoning', async (_e, level) => {
    stateMachine.setReasoningLevel(level);
    return stateMachine.getSnapshot();
  });

  ipcMain.handle('companion:clearStaging', async () => {
    stagingBuffer.clear();
    return true;
  });

  ipcMain.handle('companion:dispatchStaging', async () => {
    await hookManager.dispatchStagedItems();
    return true;
  });

  // ---------------- FILE DIALOGS ----------------
  ipcMain.handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach Images or Files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (result.canceled) return [];
    return result.filePaths;
  });
}

module.exports = {
  registerIpcHandlers,
};
