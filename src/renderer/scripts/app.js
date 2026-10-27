/**
 * Main Application Coordinator
 * Coordinates conversation lifecycle, composer interactions, Web Audio playback
 * with hardware setSinkId() routing, and microphone recording for push-to-talk.
 */
class OmniscienceApp {
  constructor() {
    this.activeConversationId = null;
    this.attachedFilePaths = []; // Array of local file paths
    this.audioContext = null;
    this.mediaRecorder = null;
    this.recordedAudioChunks = [];

    // DOM Elements
    this.sidebar = document.getElementById('sidebar');
    this.sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
    this.sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
    this.newChatBtn = document.getElementById('new-chat-btn');
    this.conversationList = document.getElementById('conversation-history-list');

    this.composerTextarea = document.getElementById('composer-textarea');
    this.sendMessageBtn = document.getElementById('send-message-btn');
    this.attachFileBtn = document.getElementById('attach-file-btn');
    this.attachmentsContainer = document.getElementById('composer-attachments');
    this.modelSelect = document.getElementById('model-select');
    this.isGenerating = false;

    // Keybinds Modal Elements
    this.openKeybindsBtn = document.getElementById('open-keybinds-btn');
    this.keybindsModal = document.getElementById('keybinds-modal');
    this.closeKeybindsModalBtn = document.getElementById('close-keybinds-modal-btn');
    this.closeKeybindsDoneBtn = document.getElementById('close-keybinds-done-btn');

    // UI Sub-Controllers
    this.chatView = new window.ChatView();
    this.companionUI = new window.CompanionUI();
    this.settingsUI = new window.SettingsUI();

    this.init();
  }

  async init() {
    this.initAudioContext();
    this.bindEvents();
    this.bindAudioListeners();
    this.bindVoiceRecordingListeners();

    try {
      const currentModel = await window.omniscienceAPI.getActiveModel();
      if (this.modelSelect && currentModel) {
        this.modelSelect.value = currentModel;
      }
    } catch (_e) {}

    // Synchronize UI dropdown when model is changed via global shortcut (R-CTRL + Arrow Up hold)
    if (window.omniscienceAPI && typeof window.omniscienceAPI.onModelChanged === 'function') {
      window.omniscienceAPI.onModelChanged((model) => {
        if (this.modelSelect && model) {
          this.modelSelect.value = model;
        }
      });
    }

    // Real-time updates from Companion Save Mode (no refresh needed)
    if (window.omniscienceAPI && typeof window.omniscienceAPI.onCompanionMessageAdded === 'function') {
      window.omniscienceAPI.onCompanionMessageAdded(async ({ conversationId, message }) => {
        if (this.activeConversationId === conversationId) {
          this.chatView.appendMessage({
            role: message.role,
            content: message.content,
            attachments: message.attachments || [],
          });
        } else if (!this.activeConversationId) {
          await this.selectConversation(conversationId);
        }
        await this.loadConversations();
      });
    }

    await this.loadConversations();
    const recent = await window.omniscienceAPI.getRecentConversation();
    if (recent) {
      await this.selectConversation(recent.id);
    }
  }

  /**
   * Initializes the Web Audio API context for zero-latency audio playback and sinkId routing.
   */
  initAudioContext() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioContext = new AudioContextClass();
      }
    } catch (_err) {
      // AudioContext will initialize on first user interaction
    }
  }

  async ensureAudioContextRunning() {
    if (!this.audioContext) {
      this.initAudioContext();
    }
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (_e) {}
    }
  }

  bindEvents() {
    // Sidebar Collapse / Expand
    this.sidebarCollapseBtn.addEventListener('click', () => {
      this.sidebar.classList.add('is-collapsed');
      this.sidebarExpandBtn.style.display = 'inline-flex';
    });

    this.sidebarExpandBtn.addEventListener('click', () => {
      this.sidebar.classList.remove('is-collapsed');
      this.sidebarExpandBtn.style.display = 'none';
    });

    // New Chat Button
    this.newChatBtn.addEventListener('click', async () => {
      await this.createNewConversation();
    });

    // Keybinds Cheat Sheet Modal
    if (this.openKeybindsBtn) {
      this.openKeybindsBtn.addEventListener('click', () => {
        if (this.keybindsModal) this.keybindsModal.classList.remove('is-hidden');
      });
    }

    if (this.closeKeybindsModalBtn) {
      this.closeKeybindsModalBtn.addEventListener('click', () => {
        if (this.keybindsModal) this.keybindsModal.classList.add('is-hidden');
      });
    }

    if (this.closeKeybindsDoneBtn) {
      this.closeKeybindsDoneBtn.addEventListener('click', () => {
        if (this.keybindsModal) this.keybindsModal.classList.add('is-hidden');
      });
    }

    if (this.keybindsModal) {
      this.keybindsModal.addEventListener('click', (e) => {
        if (e.target === this.keybindsModal) {
          this.keybindsModal.classList.add('is-hidden');
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.keybindsModal && !this.keybindsModal.classList.contains('is-hidden')) {
        this.keybindsModal.classList.add('is-hidden');
      }
    });

    // Composer Input auto-expand & submit
    this.composerTextarea.addEventListener('input', () => {
      this.composerTextarea.style.height = 'auto';
      this.composerTextarea.style.height = `${Math.min(this.composerTextarea.scrollHeight, 180)}px`;
    });

    this.composerTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.isGenerating) {
          return; // Anti-spam: Do not allow sending while generation is in progress
        }
        this.handleSendMessage();
      }
    });

    this.sendMessageBtn.addEventListener('click', () => {
      if (this.isGenerating) {
        this.handleStopGeneration();
      } else {
        this.handleSendMessage();
      }
    });

    // Model Selector Change
    if (this.modelSelect) {
      this.modelSelect.addEventListener('change', async () => {
        await window.omniscienceAPI.setActiveModel(this.modelSelect.value);
      });
    }

    // File Attachment Dialog
    this.attachFileBtn.addEventListener('click', async () => {
      const filePaths = await window.omniscienceAPI.openFilesDialog();
      if (filePaths && filePaths.length > 0) {
        this.addAttachments(filePaths);
      }
    });

    // Drag-and-Drop Files into Composer
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const paths = [];
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          if (file.path) paths.push(file.path);
        }
        if (paths.length > 0) {
          this.addAttachments(paths);
        }
      }
    });

    // Clipboard Paste Files / Screenshots
    this.composerTextarea.addEventListener('paste', (e) => {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        const paths = [];
        for (let i = 0; i < e.clipboardData.files.length; i++) {
          const file = e.clipboardData.files[i];
          if (file.path) paths.push(file.path);
        }
        if (paths.length > 0) {
          this.addAttachments(paths);
        }
      }
    });
  }

  /**
   * Sets up listeners for programmatic earcon WAV and neural TTS playback with sinkId routing.
   */
  bindAudioListeners() {
    // Play synthesized earcon WAV
    window.omniscienceAPI.onPlayEarconWav(async ({ buffer, sinkId }) => {
      await this.playAudioBuffer(buffer, 1.0, 1.0, sinkId);
    });

    // Play synthesized TTS MP3 audio
    window.omniscienceAPI.onPlayTTSBuffer(async ({ buffer, playbackRate, volume, sinkId }) => {
      await this.playAudioBuffer(buffer, playbackRate || 1.0, volume || 1.0, sinkId);
    });
  }

  /**
   * Decodes and plays an audio buffer using Web Audio API and routes to selected sinkId.
   * @param {Uint8Array|ArrayBuffer} rawBuffer
   * @param {number} rate
   * @param {number} volume
   * @param {string} sinkId
   */
  async playAudioBuffer(rawBuffer, rate = 1.0, volume = 1.0, sinkId = 'default') {
    if (!rawBuffer) return;
    await this.ensureAudioContextRunning();

    try {
      if (!this.audioContext) {
        this.initAudioContext();
      }

      // Route AudioContext to specific hardware sink if supported
      if (typeof this.audioContext.setSinkId === 'function' && sinkId && sinkId !== 'default') {
        try {
          await this.audioContext.setSinkId(sinkId);
        } catch (_e) {
          // Fallback to default
        }
      }

      const arrayBuf = rawBuffer.buffer
        ? rawBuffer.buffer.slice(rawBuffer.byteOffset, rawBuffer.byteOffset + rawBuffer.byteLength)
        : rawBuffer;

      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuf.slice(0));
      const source = this.audioContext.createBufferSource();
      const gainNode = this.audioContext.createGain();

      source.buffer = audioBuffer;
      source.playbackRate.value = rate;
      gainNode.gain.value = Math.max(0, Math.min(1, volume));

      source.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      source.start(0);
    } catch (_err) {
      // Audio playback errors handled gracefully
    }
  }

  /**
   * Bridges push-to-talk voice recording to HTML5 MediaRecorder.
   */
  bindVoiceRecordingListeners() {
    window.omniscienceAPI.onVoiceRecordStart(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.recordedAudioChunks = [];
        this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            this.recordedAudioChunks.push(e.data);
          }
        };

        this.mediaRecorder.start();
      } catch (_err) {
        this.mediaRecorder = null;
      }
    });

    window.omniscienceAPI.onVoiceRecordStop(() => {
      if (!this.mediaRecorder) {
        window.omniscienceAPI.sendRecordedVoiceBuffer(new Uint8Array(0));
        return;
      }

      this.mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(this.recordedAudioChunks, { type: 'audio/webm' });
          const arrayBuffer = await blob.arrayBuffer();
          window.omniscienceAPI.sendRecordedVoiceBuffer(new Uint8Array(arrayBuffer));
        } catch (_e) {
          window.omniscienceAPI.sendRecordedVoiceBuffer(new Uint8Array(0));
        } finally {
          // Stop media tracks
          if (this.mediaRecorder && this.mediaRecorder.stream) {
            this.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
          }
          this.mediaRecorder = null;
        }
      };

      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    });
  }

  addAttachments(paths) {
    paths.forEach((p) => {
      if (!this.attachedFilePaths.includes(p)) {
        this.attachedFilePaths.push(p);
      }
    });
    this.renderAttachmentChips();
  }

  removeAttachment(path) {
    this.attachedFilePaths = this.attachedFilePaths.filter((p) => p !== path);
    this.renderAttachmentChips();
  }

  renderAttachmentChips() {
    this.attachmentsContainer.innerHTML = '';
    this.attachedFilePaths.forEach((p) => {
      const fileName = p.split(/[\\/]/).pop();
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'attachment-chip__name';
      nameSpan.textContent = fileName;

      const removeBtn = document.createElement('span');
      removeBtn.className = 'attachment-chip__remove';
      removeBtn.innerHTML = '<svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
      removeBtn.addEventListener('click', () => this.removeAttachment(p));

      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);
      this.attachmentsContainer.appendChild(chip);
    });
  }

  setGeneratingState(isGenerating) {
    this.isGenerating = Boolean(isGenerating);

    if (this.isGenerating) {
      this.sendMessageBtn.classList.remove('btn--primary');
      this.sendMessageBtn.classList.add('btn--stop');
      this.sendMessageBtn.title = 'Stop generating';
      this.sendMessageBtn.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24"><rect width="12" height="12" x="6" y="6" rx="2" fill="currentColor"></rect></svg>';
    } else {
      this.sendMessageBtn.classList.remove('btn--stop');
      this.sendMessageBtn.classList.add('btn--primary');
      this.sendMessageBtn.title = 'Send message (Enter)';
      this.sendMessageBtn.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>';
    }
  }

  async handleStopGeneration() {
    if (!this.isGenerating) return;
    try {
      await window.omniscienceAPI.stopGeneration();
    } catch (_e) {}

    this.setGeneratingState(false);
    this.chatView.removeThinkingIndicator();
    this.chatView.appendMessage({
      role: 'model',
      content: 'Generation stopped by user.',
    });
  }

  async handleSendMessage() {
    if (this.isGenerating) return;

    const text = this.composerTextarea.value.trim();
    const paths = [...this.attachedFilePaths];

    if (!text && paths.length === 0) return;

    if (!this.activeConversationId) {
      await this.createNewConversation();
    }

    // Reset input fields immediately
    this.composerTextarea.value = '';
    this.composerTextarea.style.height = 'auto';
    this.attachedFilePaths = [];
    this.renderAttachmentChips();

    // Optimistically render user message
    this.chatView.appendMessage({
      role: 'user',
      content: text,
      attachments: paths,
    });

    const selectedModel = this.modelSelect ? this.modelSelect.value : 'gemini-3.8-flash';
    let thinkingLabel = 'Gemini is analyzing...';
    const targetConversationId = this.activeConversationId;

    if (selectedModel === 'gemini-3.8-flash') {
      thinkingLabel = 'Gemini 3.8 Flash is reasoning (deep thinking, ~30-90s)...';
    } else if (selectedModel === 'gemini-3.6-flash') {
      thinkingLabel = 'Gemini 3.6 Flash is generating...';
    } else if (selectedModel === 'gemini-3.5-flash-lite') {
      thinkingLabel = 'Gemini 3.5 Flash Lite is generating...';
    }

    this.chatView.showThinkingIndicator(thinkingLabel);
    this.setGeneratingState(true);

    try {
      const response = await window.omniscienceAPI.sendMessage({
        conversationId: targetConversationId,
        text,
        imagePaths: paths,
        model: selectedModel,
      });

      if (this.activeConversationId === targetConversationId) {
        this.chatView.removeThinkingIndicator();

        if (response && response.content) {
          this.chatView.appendMessage({
            role: 'model',
            content: response.content,
          });
        } else {
          this.chatView.appendMessage({
            role: 'model',
            content: 'No response was returned by the model. Please check your prompt or try another model.',
          });
        }
      }

      await this.loadConversations();
    } catch (err) {
      if (this.activeConversationId === targetConversationId) {
        this.chatView.removeThinkingIndicator();
        const errMsg = String(err.message || '');
        if (errMsg.includes('stopped by user')) {
          this.chatView.appendMessage({
            role: 'model',
            content: 'Generation stopped by user.',
          });
        } else {
          this.chatView.appendMessage({
            role: 'model',
            content: `Error: ${errMsg || 'Failed to generate response.'}`,
          });
        }
      }
    } finally {
      this.setGeneratingState(false);
    }
  }

  async createNewConversation() {
    const conv = await window.omniscienceAPI.createConversation({
      title: 'New Conversation',
      reasoning_level: this.companionUI.currentState.reasoningLevel || 'low',
    });

    await this.loadConversations();
    await this.selectConversation(conv.id);
  }

  async selectConversation(conversationId) {
    this.activeConversationId = conversationId;
    const items = this.conversationList.querySelectorAll('.history-item');
    items.forEach((item) => {
      if (item.getAttribute('data-id') === conversationId) {
        item.classList.add('is-active');
      } else {
        item.classList.remove('is-active');
      }
    });

    const messages = await window.omniscienceAPI.listMessages(conversationId);
    this.chatView.renderMessages(messages);
  }

  async loadConversations() {
    const conversations = await window.omniscienceAPI.listConversations();
    this.conversationList.innerHTML = '';

    conversations.forEach((conv) => {
      const li = document.createElement('li');
      const item = document.createElement('div');
      item.className = 'history-item';
      item.setAttribute('data-id', conv.id);
      if (conv.id === this.activeConversationId) {
        item.classList.add('is-active');
      }

      const titleSpan = document.createElement('span');
      titleSpan.className = 'history-item__title';
      titleSpan.textContent = conv.title || 'Untitled Conversation';

      const actions = document.createElement('div');
      actions.className = 'history-item__actions';

      // Rename button
      const renameBtn = document.createElement('button');
      renameBtn.className = 'btn btn--icon btn--ghost btn--sm';
      renameBtn.title = 'Rename';
      renameBtn.innerHTML = '<svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg>';
      renameBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newTitle = prompt('Rename conversation:', conv.title);
        if (newTitle && newTitle.trim()) {
          await window.omniscienceAPI.renameConversation(conv.id, newTitle.trim());
          await this.loadConversations();
        }
      });

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn--icon btn--ghost btn--sm';
      deleteBtn.title = 'Delete';
      deleteBtn.innerHTML = '<svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete conversation "${conv.title}"?`)) {
          await window.omniscienceAPI.deleteConversation(conv.id);
          if (this.activeConversationId === conv.id) {
            this.activeConversationId = null;
            this.chatView.clear();
          }
          await this.loadConversations();
        }
      });

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(titleSpan);
      item.appendChild(actions);

      item.addEventListener('click', () => {
        this.selectConversation(conv.id);
      });

      li.appendChild(item);
      this.conversationList.appendChild(li);
    });
  }
}

// Instantiate app once DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  window.app = new OmniscienceApp();
});
