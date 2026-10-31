/**
 * Companion UI Controller
 * Manages the top-right Companion popover, armed state, Save/Throw sub-modes,
 * reasoning level segmented controls, and staging indicators.
 */
class CompanionUI {
  constructor() {
    this.popoverBtn = document.getElementById('companion-popover-btn');
    this.popover = document.getElementById('companion-popover');
    this.popoverClose = document.getElementById('companion-popover-close');
    this.armBtn = document.getElementById('companion-arm-btn');
    this.btnLabel = document.getElementById('companion-btn-label');

    this.throwModeCheckbox = document.getElementById('throw-mode-checkbox');

    this.stagingBanner = document.getElementById('staging-status-banner');
    this.stagingText = document.getElementById('staging-status-text');
    this.stagingClearBtn = document.getElementById('staging-clear-btn');
    this.stagingSendBtn = document.getElementById('staging-send-btn');

    this.reasoningControl = document.getElementById('reasoning-segmented-control');

    this.currentState = {
      state: 'IDLE',
      subMode: 'save',
      reasoningLevel: 'low',
      isArmed: false,
    };

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.refreshState();

    // Subscribe to IPC state updates from the Main process
    window.omniscienceAPI.onCompanionStatusChanged((snapshot) => {
      this.updateUI(snapshot);
    });

    window.omniscienceAPI.onCompanionStagingChanged((staging) => {
      this.updateStagingUI(staging);
    });
  }

  bindEvents() {
    // Toggle popover visibility
    this.popoverBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.popover.classList.toggle('is-hidden');
    });

    this.popoverClose.addEventListener('click', () => {
      this.popover.classList.add('is-hidden');
    });

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.popover.contains(e.target) && !this.popoverBtn.contains(e.target)) {
        this.popover.classList.add('is-hidden');
      }
    });

    // Throw Mode Checkbox change listener
    if (this.throwModeCheckbox) {
      this.throwModeCheckbox.addEventListener('change', async () => {
        const mode = this.throwModeCheckbox.checked ? 'throw' : 'save';
        await this.setSubMode(mode);
      });
    }

    // Arm button click
    this.armBtn.addEventListener('click', async () => {
      const nextArmed = !this.currentState.isArmed;
      const updated = await window.omniscienceAPI.setCompanionArmed(nextArmed);
      this.updateUI(updated);
    });

    // Staging clear & send buttons
    this.stagingClearBtn.addEventListener('click', async () => {
      await window.omniscienceAPI.clearStaging();
    });

    this.stagingSendBtn.addEventListener('click', async () => {
      await window.omniscienceAPI.dispatchStaging();
    });

    // Reasoning Level segmented controls
    const buttons = this.reasoningControl.querySelectorAll('.segmented-control__item');
    buttons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const level = btn.getAttribute('data-level');
        const updated = await window.omniscienceAPI.setReasoningLevel(level);
        this.updateUI(updated);
      });
    });
  }

  async setSubMode(mode) {
    const updated = await window.omniscienceAPI.setCompanionSubMode(mode);
    this.updateUI(updated);
  }

  async refreshState() {
    try {
      const snapshot = await window.omniscienceAPI.getCompanionStatus();
      this.updateUI(snapshot);
      if (snapshot.staging) {
        this.updateStagingUI(snapshot.staging);
      }
    } catch (_err) {
      // Ignored
    }
  }

  updateUI(snapshot) {
    this.currentState = { ...this.currentState, ...snapshot };

    // Armed status & Radar button
    if (this.currentState.isArmed) {
      this.popoverBtn.classList.add('is-armed');
      this.armBtn.textContent = 'Deactivate Companion Standby';
      this.armBtn.classList.remove('btn--primary');
      this.armBtn.classList.add('btn--ghost');
      this.btnLabel.textContent = `Companion (${this.currentState.subMode === 'save' ? 'Save' : 'Throw'})`;
    } else {
      this.popoverBtn.classList.remove('is-armed');
      this.armBtn.textContent = 'Activate Companion Standby';
      this.armBtn.classList.add('btn--primary');
      this.armBtn.classList.remove('btn--ghost');
      this.btnLabel.textContent = 'Companion';
    }

    // Throw Mode Checkbox sync
    if (this.throwModeCheckbox) {
      this.throwModeCheckbox.checked = (this.currentState.subMode === 'throw');
    }

    // Reasoning segmented control
    const buttons = this.reasoningControl.querySelectorAll('.segmented-control__item');
    buttons.forEach((btn) => {
      if (btn.getAttribute('data-level') === this.currentState.reasoningLevel) {
        btn.classList.add('is-active');
      } else {
        btn.classList.remove('is-active');
      }
    });
  }

  updateStagingUI(staging) {
    if (!staging) return;
    const count = staging.imageCount || 0;
    const hasText = staging.hasText;

    if (count > 0 || hasText) {
      this.stagingBanner.style.display = 'flex';
      let desc = '';
      if (count > 0 && hasText) {
        desc = `${count} screenshot(s) and voice note staged in memory`;
      } else if (count > 0) {
        desc = `${count} screenshot(s) staged in memory`;
      } else {
        desc = 'Voice instruction staged in memory';
      }
      this.stagingText.textContent = desc;
    } else {
      this.stagingBanner.style.display = 'none';
    }
  }
}

window.CompanionUI = CompanionUI;
