const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const {
  listAllowedApps,
  promptAddAllowedApp,
  removeAllowedApp,
  openAllowedApp,
  closeAllowedApp,
} = require('./appControl.cjs');

const isDev = !app.isPackaged;
let mainWindow = null;
let teacherWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.openDevTools();
}

// The floating teacher lives in its own transparent, frameless,
// always-on-top window so it can sit on top of Word, a browser, or
// anything else — a normal in-app panel can't escape the main window's
// bounds. It's click-through everywhere except the avatar itself is
// dragged via the "-webkit-app-region: drag" CSS region declared in
// TeacherOverlay's markup.
function createTeacherWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const size = 320;

  teacherWindow = new BrowserWindow({
    width: size,
    height: size,
    x: width - size - 40,
    y: height - size - 40,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  teacherWindow.setAlwaysOnTop(true, 'screen-saver');

  if (isDev) {
    teacherWindow.loadURL('http://localhost:5173/teacher.html');
  } else {
    teacherWindow.loadFile(path.join(__dirname, '..', 'dist', 'teacher.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  createTeacherWindow();

  // These were previously declared in preload.cjs but never wired up here,
  // so every apps:* call from the renderer was hanging with no handler.
  ipcMain.handle('apps:list', () => listAllowedApps());
  ipcMain.handle('apps:add', () => promptAddAllowedApp(mainWindow));
  ipcMain.handle('apps:remove', (_event, id) => removeAllowedApp(id));
  ipcMain.handle('apps:open', (_event, id) => openAllowedApp(id));
  ipcMain.handle('apps:close', (_event, id) => closeAllowedApp(id));

  // Relay: main app window says "I'm speaking" / "I'm done" -> forwarded
  // to the teacher overlay window so its avatar can animate accordingly.
  ipcMain.on('teacher:speak-state', (_event, speaking) => {
    teacherWindow?.webContents.send('teacher:speak-state', speaking);
  });

  // Lets the overlay's drag handle move the actual OS window, since a
  // frameless transparent window has no native title bar to drag by.
  // setPosition() is a native Electron binding that throws (crashing the
  // whole main process, not just this handler) if given anything other
  // than a finite integer — so we validate before calling it, rather than
  // trusting whatever numbers the renderer sent over IPC.
  ipcMain.on('teacher:move-by', (_event, dx, dy) => {
    if (!teacherWindow) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = teacherWindow.getPosition();
    teacherWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  // Lets the overlay's autonomous walk logic know how far it can roam
  // (screen work area) and where it currently sits, so it can pick a
  // random destination on-screen without wandering off it.
  ipcMain.handle('teacher:get-bounds', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const [x, y] = teacherWindow ? teacherWindow.getPosition() : [0, 0];
    const [winWidth, winHeight] = teacherWindow ? teacherWindow.getSize() : [320, 320];
    return { screenWidth: width, screenHeight: height, x, y, winWidth, winHeight };
  });

  // Same finite-number guard as teacher:move-by — this one sets an
  // absolute position (used by the walk loop) rather than a delta.
  ipcMain.on('teacher:set-position', (_event, x, y) => {
    if (!teacherWindow) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    teacherWindow.setPosition(Math.round(x), Math.round(y));
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createTeacherWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
