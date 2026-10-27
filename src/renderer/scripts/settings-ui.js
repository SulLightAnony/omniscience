/**
 * Settings UI Controller
 * Manages the API key pool list, audio output device selection via Web Audio,
 * and independent earcon/TTS volume sliders.
 */
class SettingsUI {
  constructor() {
    this.modalBackdrop = document.getElementById('settings-modal-backdrop');
    this.openBtn = document.getElementById('open-settings-btn');
    this.closeBtn = document.getElementById('close-settings-modal-btn');
    this.saveBtn = document.getElementById('save-settings-modal-btn');

    this.newKeyInput = document.getElementById('new-api-key-input');
    this.addKeyBtn = document.getElementById('add-api-key-btn');
    this.keyList = document.getElementById('modal-key-pool-list');

    this.deviceSelect = document.getElementById('audio-output-device-select');
    this.earconSlider = document.getElementById('earcon-volume-slider');
    this.earconLabel = document.getElementById('earcon-volume-label');
    this.ttsSlider = document.getElementById('tts-volume-slider');
    this.ttsLabel = document.getElementById('tts-volume-label');

    this.testEarconBtn = document.getElementById('test-earcon-btn');
    this.testTtsBtn = document.getElementById('test-tts-btn');

    this.sidebarKeyDot = document.getElementById('sidebar-key-dot');
    this.sidebarKeyText = document.getElementById('sidebar-key-text');

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.populateAudioDevices();
    await this.loadSettings();
    await this.refreshKeyPoolStatus();
  }

  bindEvents() {
    this.openBtn.addEventListener('click', () => {
      this.openModal();
    });

    const closeModal = () => {
      this.modalBackdrop.classList.add('is-hidden');
    };

    this.closeBtn.addEventListener('click', closeModal);
    this.saveBtn.addEventListener('click', closeModal);

    this.modalBackdrop.addEventListener('click', (e) => {
      if (e.target === this.modalBackdrop) {
        closeModal();
      }
    });

    // Add API Key
    this.addKeyBtn.addEventListener('click', () => this.handleAddKey());
    this.newKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.handleAddKey();
      }
    });

    // Audio Device selection
    this.deviceSelect.addEventListener('change', async () => {
      const deviceId = this.deviceSelect.value;
      await window.omniscienceAPI.setAudioDevice(deviceId);
    });

    // Volume Sliders
    this.earconSlider.addEventListener('input', () => {
      const val = parseInt(this.earconSlider.value, 10);
      this.earconLabel.textContent = `${val}%`;
      this.syncVolumes();
    });

    this.ttsSlider.addEventListener('input', () => {
      const val = parseInt(this.ttsSlider.value, 10);
      this.ttsLabel.textContent = `${val}%`;
      this.syncVolumes();
    });

    // Audio Test Buttons
    this.testEarconBtn.addEventListener('click', () => {
      window.omniscienceAPI.playEarcon('short');
    });

    this.testTtsBtn.addEventListener('click', () => {
      window.omniscienceAPI.replayLastAudio(1.0);
    });
  }

  openModal() {
    this.modalBackdrop.classList.remove('is-hidden');
    this.populateAudioDevices();
    this.refreshKeyPoolStatus();
  }

  async syncVolumes() {
    const earconVolume = parseInt(this.earconSlider.value, 10) / 100;
    const ttsVolume = parseInt(this.ttsSlider.value, 10) / 100;
    await window.omniscienceAPI.setVolumes({ earconVolume, ttsVolume });
  }

  async loadSettings() {
    try {
      const settings = await window.omniscienceAPI.getSettings();
      if (settings) {
        if (settings.audio_output_device_id) {
          this.deviceSelect.value = settings.audio_output_device_id;
        }
        if (settings.earcon_volume !== undefined) {
          const pct = Math.round(settings.earcon_volume * 100);
          this.earconSlider.value = pct;
          this.earconLabel.textContent = `${pct}%`;
        }
        if (settings.tts_volume !== undefined) {
          const pct = Math.round(settings.tts_volume * 100);
          this.ttsSlider.value = pct;
          this.ttsLabel.textContent = `${pct}%`;
        }
      }
    } catch (_err) {
      // Ignored
    }
  }

  async populateAudioDevices() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter((d) => d.kind === 'audiooutput');

      const currentValue = this.deviceSelect.value || 'default';
      this.deviceSelect.innerHTML = '<option value="default">Default System Audio Device</option>';

      audioOutputs.forEach((device, index) => {
        if (device.deviceId && device.deviceId !== 'default') {
          const opt = document.createElement('option');
          opt.value = device.deviceId;
          opt.textContent = device.label || `Audio Output ${index + 1}`;
          this.deviceSelect.appendChild(opt);
        }
      });

      this.deviceSelect.value = currentValue;
    } catch (_err) {
      // Handled silently
    }
  }

  async handleAddKey() {
    const key = this.newKeyInput.value.trim();
    if (!key) return;

    await window.omniscienceAPI.addApiKey(key);
    this.newKeyInput.value = '';
    await this.refreshKeyPoolStatus();
  }

  async handleDeleteKey(index) {
    await window.omniscienceAPI.removeApiKey(index);
    await this.refreshKeyPoolStatus();
  }

  async refreshKeyPoolStatus() {
    try {
      const status = await window.omniscienceAPI.getKeyPoolStatus();
      this.renderKeyList(status);
      this.updateSidebarIndicator(status);
    } catch (_err) {
      // Ignored
    }
  }

  renderKeyList(status) {
    this.keyList.innerHTML = '';
    if (!status || !status.keys || status.keys.length === 0) {
      this.keyList.innerHTML = '<div style="padding: var(--space-3); color: var(--color-text-muted); text-align: center; font-size: var(--font-size-xs);">No API keys registered. Add at least one key to begin.</div>';
      return;
    }

    status.keys.forEach((keyItem) => {
      const row = document.createElement('div');
      row.className = 'key-pool-item';

      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      left.style.gap = 'var(--space-2)';

      const keyText = document.createElement('span');
      keyText.style.fontFamily = 'var(--font-family-mono)';
      keyText.textContent = keyItem.masked;

      const badge = document.createElement('span');
      badge.className = `key-pool-badge ${keyItem.status === 'READY' ? 'is-ready' : 'is-cooldown'}`;
      badge.textContent = keyItem.status === 'READY' ? 'READY' : `COOLDOWN (${keyItem.remainingSeconds}s)`;

      left.appendChild(keyText);
      left.appendChild(badge);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn--icon btn--ghost btn--sm';
      delBtn.title = 'Remove API key';
      delBtn.innerHTML = '<svg class="svg-icon svg-icon--sm" viewBox="0 0 24 24"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
      delBtn.addEventListener('click', () => this.handleDeleteKey(keyItem.index));

      row.appendChild(left);
      row.appendChild(delBtn);
      this.keyList.appendChild(row);
    });
  }

  updateSidebarIndicator(status) {
    if (!status) return;
    const ready = status.ready || 0;
    const total = status.total || 0;

    this.sidebarKeyText.textContent = `${ready} / ${total} Keys Ready`;

    this.sidebarKeyDot.classList.remove('is-warning', 'is-danger');
    if (total === 0 || ready === 0) {
      this.sidebarKeyDot.classList.add('is-danger');
    } else if (ready < total) {
      this.sidebarKeyDot.classList.add('is-warning');
    }
  }
}

window.SettingsUI = SettingsUI;
