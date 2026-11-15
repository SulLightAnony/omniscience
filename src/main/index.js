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
const { registerIpcHandlers } = require('./ipc-handlers');
const { ttsEngine } = require('./audio/tts-engine');
const { earconSynth } = require('./audio/earcon-synth');

function restoreSystemCursorFailsafe() {
  try {
    earconSynth.cancelActiveEarcon();
  } catch (_err) {
    // Ignored
  }
}

let mainWindow = null;
let isQuitting = false;
app.isQuitting = false;

// 1. Single Instance Lock Enforcement
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

// 2. Single Instance Handoff: restore and focus existing background workspace
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.restore();
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

    // SECTION 3: Apply standard Win32 SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
    try {
      const hwndBuf = mainWindow.getNativeWindowHandle();
      let mouseSuppressor = null;
      try {
        mouseSuppressor = require(path.join(__dirname, '../../native-addons/build/Release/mouse_suppressor.node'));
      } catch (_e1) {
        try {
          mouseSuppressor = require(path.join(__dirname, '../../native-addons/build/Debug/mouse_suppressor.node'));
        } catch (_e2) {}
      }

      if (mouseSuppressor && typeof mouseSuppressor.setWindowExcludeFromCapture === 'function') {
        mouseSuppressor.setWindowExcludeFromCapture(hwndBuf);
      }
    } catch (affinityErr) {
      console.error('Failed to set window display affinity via native addon:', affinityErr);
    }

    // Also apply Electron content protection (wraps SetWindowDisplayAffinity on Windows)
    try {
      mainWindow.setContentProtection(true);
    } catch (_e) {}
  });

  // SECTION 1: Intercept close event: hide window and remove from taskbar, keeping background daemon alive
  mainWindow.on('close', (event) => {
    if (!isQuitting && !app.isQuitting) {
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

  // Start global input hooks (asynchronous native C++ listener + uiohook)
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
  restoreSystemCursorFailsafe();
  hookManager.stop();
  closeDb();
});

app.on('will-quit', () => {
  restoreSystemCursorFailsafe();
});

process.on('exit', () => {
  restoreSystemCursorFailsafe();
});

process.on('uncaughtException', (err) => {
  restoreSystemCursorFailsafe();
  console.error('Uncaught exception in main process:', err);
});

app.on('window-all-closed', () => {
  // Maintain background Node.js event loop active for global hotkey processing unless quitting
  if (isQuitting || app.isQuitting) {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  }
});
