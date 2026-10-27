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

  ensureAudioContextRunning() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
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

    // Composer Input auto-expand & submit
    this.composerTextarea.addEventListener('input', () => {
      this.composerTextarea.style.height = 'auto';
      this.composerTextarea.style.height = `${Math.min(this.composerTextarea.scrollHeight, 180)}px`;
    });

    this.composerTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      }
    });

    this.sendMessageBtn.addEventListener('click', () => {
      this.handleSendMessage();
    });

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
    this.ensureAudioContextRunning();

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

  async handleSendMessage() {
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

    try {
      const response = await window.omniscienceAPI.sendMessage({
        conversationId: this.activeConversationId,
        text,
        imagePaths: paths,
      });

      if (response && response.content) {
        this.chatView.appendMessage({
          role: 'model',
          content: response.content,
        });
      }

      await this.loadConversations();
    } catch (err) {
      this.chatView.appendMessage({
        role: 'model',
        content: `Error: ${err.message || 'Failed to generate response.'}`,
      });
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
