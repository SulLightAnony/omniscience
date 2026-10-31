const path = require('path');
const electron = require('electron');

// Defensive self-healing: If launched under ELECTRON_RUN_AS_NODE (e.g. VS Code / Antigravity terminal),
// re-spawn the true Electron binary with the environment variable removed.
if (typeof electron === 'string') {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, process.argv.slice(1), {
    stdio: 'inherit',
    env,
    windowsHide: false,
  });
  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
  return;
}

const { app, BrowserWindow } = electron;

// Ensure Web Audio API and speech synthesis play smoothly in background without user gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { initDatabase, closeDb } = require('./database/sqlite-client');
const { hookManager } = require('./companion/hook-manager');
const { stateMachine } = require('./companion/state-machine');
const { registerIpcHandlers } = require('./ipc-handlers');
const { setupTray, destroyTray } = require('./tray-manager');
const { ttsEngine } = require('./audio/tts-engine');

let mainWindow = null;
let isQuitting = false;
app.isQuitting = false;

// 1. Single Instance Lock Enforcement
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // If user launches Omniscience.exe while it is already running (e.g. in Companion Mode),
  // immediately restore, unhide, and focus the main window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../build/icon.ico'),
    backgroundColor: '#131314', // Default Gemini Dark Mode background
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // Keep Web Audio & voice recording running when hidden
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Intercept close event: hide window and remove from taskbar if Companion Mode is armed
  mainWindow.on('close', (event) => {
    if (!isQuitting && !app.isQuitting && stateMachine.isCompanionArmed()) {
      event.preventDefault();
      mainWindow.setSkipTaskbar(true);
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

app.whenReady().then(async () => {
  // Initialize local SQLite database
  initDatabase();

  // Create main UI window
  const win = createWindow();

  // Register IPC communication bridge
  registerIpcHandlers(win, hookManager);

  // Initialize Windows System Tray defensively
  try {
    setupTray(win, () => {
      isQuitting = true;
      app.isQuitting = true;
      app.quit();
    });
  } catch (trayErr) {
    console.error('Failed to initialize system tray:', trayErr);
  }

  // Start global input hooks
  try {
    hookManager.start();
  } catch (hookErr) {
    console.error('Failed to start global input hooks:', hookErr);
  }

  // Warm-up TTS engine
  ttsEngine.warmUp().catch(() => {});
});

// App shutdown lifecycle
app.on('before-quit', () => {
  isQuitting = true;
  app.isQuitting = true;
  hookManager.stop();
  destroyTray();
  closeDb();
});

app.on('window-all-closed', () => {
  // If companion mode is armed, the process stays alive even if window is closed
  if (!stateMachine.isCompanionArmed()) {
    isQuitting = true;
    app.isQuitting = true;
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
  }
});
