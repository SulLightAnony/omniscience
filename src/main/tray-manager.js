const path = require('path');
const { Tray, Menu, app } = require('electron');
const { stateMachine } = require('./companion/state-machine');

let trayInstance = null;

/**
 * Initializes and manages the Windows System Tray icon and context menu.
 * @param {import('electron').BrowserWindow} mainWindow
 * @param {Function} [onQuit]
 * @returns {Tray}
 */
function initTray(mainWindow, onQuit) {
  if (trayInstance) {
    return trayInstance;
  }

  const iconPath = path.join(__dirname, '../../build/tray-icon.ico');
  trayInstance = new Tray(iconPath);
  trayInstance.setToolTip('Omniscience');

  const showWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(false);
      mainWindow.show();
      mainWindow.focus();
    }
  };

  // Double-click restores main window
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

    const reasoningTitle =
      snapshot.reasoningLevel.charAt(0).toUpperCase() + snapshot.reasoningLevel.slice(1);
    const reasoningLabel = `Reasoning Level: ${reasoningTitle}`;

    // Pure text, ZERO EMOJIS
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Omniscience Workspace',
        click: () => showWindow(),
      },
      {
        label: statusLabel,
        enabled: false,
      },
      {
        label: reasoningLabel,
        submenu: [
          {
            label: 'Low',
            type: 'radio',
            checked: snapshot.reasoningLevel === 'low',
            click: () => stateMachine.setReasoningLevel('low'),
          },
          {
            label: 'Medium',
            type: 'radio',
            checked: snapshot.reasoningLevel === 'medium',
            click: () => stateMachine.setReasoningLevel('medium'),
          },
          {
            label: 'High',
            type: 'radio',
            checked: snapshot.reasoningLevel === 'high',
            click: () => stateMachine.setReasoningLevel('high'),
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'Quit Omniscience Completely',
        click: () => {
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
    trayInstance.destroy();
    trayInstance = null;
  }
}

module.exports = {
  initTray,
  destroyTray,
};
