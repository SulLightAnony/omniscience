const path = require('path');
const fs = require('fs');
const { Tray, Menu, app, nativeImage } = require('electron');
const { stateMachine } = require('./companion/state-machine');

// Global module-scoped variable to persist the Tray object and prevent Garbage Collection
let trayInstance = null;

/**
 * Resolves the absolute path to the tray icon with defensive fallbacks.
 * @returns {string}
 */
function resolveTrayIconPath() {
  const candidates = [
    path.join(__dirname, '../../build/tray-icon.ico'),
    path.join(__dirname, 'assets/tray-icon.ico'),
    path.join(process.resourcesPath || '', 'build/tray-icon.ico'),
    path.join(process.resourcesPath || '', 'tray-icon.ico'),
    path.join(__dirname, '../../build/icon.ico'),
    path.join(__dirname, 'assets/icon.ico'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Primary reference adhering to build specification
  return path.join(__dirname, '../../build/tray-icon.ico');
}

/**
 * Initializes and manages the Windows System Tray icon and native context menu.
 * @param {import('electron').BrowserWindow} mainWindow
 * @param {Function} [onQuit]
 * @returns {Tray}
 */
function setupTray(mainWindow, onQuit) {
  if (trayInstance && !trayInstance.isDestroyed()) {
    return trayInstance;
  }

  const iconPath = resolveTrayIconPath();
  const iconImage = nativeImage.createFromPath(iconPath);
  trayInstance = new Tray(iconImage.isEmpty() ? iconPath : iconImage);
  trayInstance.setToolTip('Omniscience');

  const showWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.setSkipTaskbar(false);
      mainWindow.show();
      mainWindow.focus();
    }
  };

  // Double-click restores and focuses the main window
  trayInstance.on('double-click', () => {
    showWindow();
  });

  const rebuildMenu = () => {
    if (!trayInstance || trayInstance.isDestroyed()) return;

    const snapshot = stateMachine.getSnapshot();
    const isArmed = snapshot.isArmed;
    const subModeText = snapshot.subMode === 'save' ? 'Save Mode' : 'Throw Mode';
    const statusLabel = isArmed
      ? `Companion Status: Active (${subModeText})`
      : 'Companion Status: Inactive';

    const reasoningTitle = (snapshot.reasoningLevel || 'low').toUpperCase();
    const reasoningLabel = `Reasoning Level: ${reasoningTitle}`;

    // Pure text, ZERO EMOJIS adhering to directive specifications
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Omniscience Workspace',
        click: () => showWindow(),
      },
      { type: 'separator' },
      {
        label: statusLabel,
        enabled: false,
      },
      {
        label: reasoningLabel,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Quit Omniscience Completely',
        click: () => {
          app.isQuitting = true;
          if (typeof onQuit === 'function') {
            onQuit();
          } else {
            app.quit();
          }
        },
      },
    ]);

    trayInstance.setContextMenu(contextMenu);
  };

  // Rebuild menu on state changes
  stateMachine.on('change', () => {
    rebuildMenu();
  });

  rebuildMenu();
  return trayInstance;
}

/**
 * Destroys the tray instance cleanly.
 */
function destroyTray() {
  if (trayInstance && !trayInstance.isDestroyed()) {
    try {
      trayInstance.destroy();
    } catch (_err) {
      // Ignored
    }
    trayInstance = null;
  }
}

module.exports = {
  setupTray,
  initTray: setupTray, // Backward-compatibility alias
  destroyTray,
};
