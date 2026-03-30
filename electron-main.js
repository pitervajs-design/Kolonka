const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let kolonkaApp = null;

// Ограничение: только одна копия приложения
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Не показывать в dock на macOS (Windows — аналогичное поведение через tray)
if (process.platform === 'darwin') {
  app.dock.hide();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 600,
    resizable: true,
    minimizable: true,
    title: 'Kolonka AI',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Сворачивание в трей вместо закрытия
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    startApp();
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  updateTrayMenu();
  tray.setToolTip('Kolonka AI — Джарвис');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

function updateTrayMenu() {
  const vadLabel = kolonkaApp && kolonkaApp.vadMode ? 'VAD: Включён' : 'VAD: Выключён';
  const stateLabel = kolonkaApp ? `Состояние: ${kolonkaApp.state}` : 'Не запущен';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Kolonka AI — Джарвис', enabled: false },
    { type: 'separator' },
    { label: stateLabel, enabled: false },
    { label: vadLabel, click: () => { if (kolonkaApp) kolonkaApp.toggleVAD(); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Показать окно', click: () => { mainWindow && mainWindow.show(); } },
    { label: 'Очистить историю', click: () => { if (kolonkaApp) kolonkaApp.clearHistory(); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; shutdown(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

async function startApp() {
  const App = require('./src/app');
  kolonkaApp = new App();

  // Пробрасываем события в renderer
  kolonkaApp.on('log', (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log', msg);
    }
  });

  kolonkaApp.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state', state);
    }
    updateTrayMenu();
  });

  kolonkaApp.on('vadMode', (enabled) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vadMode', enabled);
    }
    updateTrayMenu();
  });

  kolonkaApp.on('userText', (text) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('userText', text);
    }
  });

  kolonkaApp.on('aiText', (text) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('aiText', text);
    }
  });

  kolonkaApp.on('ready', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ready');
    }
  });

  // Пробрасываем команды управления VAD в renderer
  kolonkaApp.on('vadControl', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vad-control', data);
    }
  });

  kolonkaApp.on('micChanged', (name) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('micChanged', name);
    }
  });

  await kolonkaApp.start();
}

// IPC из renderer
ipcMain.on('ptt-start', () => {
  if (kolonkaApp) kolonkaApp.startRecording();
});

ipcMain.on('ptt-stop', () => {
  if (kolonkaApp) kolonkaApp.stopRecording();
});

ipcMain.on('toggle-vad', () => {
  if (kolonkaApp) kolonkaApp.toggleVAD();
});

ipcMain.on('clear-history', () => {
  if (kolonkaApp) kolonkaApp.clearHistory();
});

ipcMain.on('send-text', (_, text) => {
  if (kolonkaApp) kolonkaApp.sendText(text);
});

ipcMain.handle('get-mics', async () => {
  if (kolonkaApp) return kolonkaApp.getMicrophones();
  return [];
});

ipcMain.on('switch-mic', (_, deviceName) => {
  if (kolonkaApp) kolonkaApp.switchMicrophone(deviceName);
});

// VAD из renderer (Web Audio API)
ipcMain.on('vad-speech', (_, wavBuffer) => {
  // IPC structured clone converts Buffer → Uint8Array; convert back
  if (kolonkaApp) kolonkaApp.handleVADSpeech(Buffer.from(wavBuffer));
});

ipcMain.on('vad-speech-start', () => {
  if (kolonkaApp) kolonkaApp.handleVADSpeechStart();
});

ipcMain.on('vad-debug', (_, msg) => {
  if (kolonkaApp) kolonkaApp._log(msg);
});

ipcMain.on('vad-error', (_, msg) => {
  if (kolonkaApp) kolonkaApp._error(`[WebVAD] ${msg}`);
});

ipcMain.on('quit', () => {
  app.isQuitting = true;
  shutdown();
});

ipcMain.on('win-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('win-maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});

async function shutdown() {
  if (kolonkaApp) {
    await kolonkaApp.shutdown();
  }
  app.quit();
}

// Electron lifecycle
app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  // Не закрываем — работаем в трее
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', async () => {
  if (kolonkaApp) {
    await kolonkaApp.shutdown();
  }
});
