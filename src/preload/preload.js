const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omniscienceAPI', {
  // Conversations
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getConversation: (id) => ipcRenderer.invoke('conversations:get', id),
  createConversation: (params) => ipcRenderer.invoke('conversations:create', params || {}),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', { id, title }),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  getRecentConversation: () => ipcRenderer.invoke('conversations:getRecent'),

  // Messages
  listMessages: (conversationId) => ipcRenderer.invoke('messages:list', conversationId),
  sendMessage: (params) => ipcRenderer.invoke('messages:send', params),

  // Settings & API Key Pool
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (updates) => ipcRenderer.invoke('settings:update', updates),
  getKeyPoolStatus: () => ipcRenderer.invoke('keys:status'),
  addApiKey: (key) => ipcRenderer.invoke('keys:add', key),
  removeApiKey: (identifier) => ipcRenderer.invoke('keys:remove', identifier),
  setAudioDevice: (deviceId) => ipcRenderer.invoke('audio:setDevice', deviceId),
  setVolumes: (volumes) => ipcRenderer.invoke('audio:setVolumes', volumes),
  replayLastAudio: (speed) => ipcRenderer.invoke('audio:replay', speed),
  playEarcon: (pattern) => ipcRenderer.invoke('audio:playEarcon', pattern),

  // Companion Mode
  getCompanionStatus: () => ipcRenderer.invoke('companion:status'),
  setCompanionArmed: (armed) => ipcRenderer.invoke('companion:setArmed', armed),
  setCompanionSubMode: (mode) => ipcRenderer.invoke('companion:setSubMode', mode),
  setReasoningLevel: (level) => ipcRenderer.invoke('companion:setReasoning', level),
  clearStaging: () => ipcRenderer.invoke('companion:clearStaging'),
  dispatchStaging: () => ipcRenderer.invoke('companion:dispatchStaging'),

  // Subscriptions from Main Process
  onCompanionStatusChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('companion:status-changed', handler);
    return () => ipcRenderer.removeListener('companion:status-changed', handler);
  },
  onCompanionStagingChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('companion:staging-changed', handler);
    return () => ipcRenderer.removeListener('companion:staging-changed', handler);
  },

  // Audio Playback Events
  onPlayEarconWav: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('audio:play-earcon-wav', handler);
    return () => ipcRenderer.removeListener('audio:play-earcon-wav', handler);
  },
  onPlayTTSBuffer: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('audio:play-tts-buffer', handler);
    return () => ipcRenderer.removeListener('audio:play-tts-buffer', handler);
  },

  // Push-to-Talk Voice Recording Bridge
  onVoiceRecordStart: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('voice:record-start', handler);
    return () => ipcRenderer.removeListener('voice:record-start', handler);
  },
  onVoiceRecordStop: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('voice:record-stop', handler);
    return () => ipcRenderer.removeListener('voice:record-stop', handler);
  },
  sendRecordedVoiceBuffer: (buffer) => {
    ipcRenderer.send('voice:recorded-buffer', buffer);
  },

  // File Dialog
  openFilesDialog: () => ipcRenderer.invoke('dialog:openFiles'),
});
