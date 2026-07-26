const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const {
  listAllowedApps,
  promptAddAllowedApp,
  removeAllowedApp,
  openAllowedApp,
  closeAllowedApp,
} = require('./appControl.cjs');
const vscodeBridge = require('./vscodeBridge.cjs');

const isDev = !app.isPackaged;
let mainWindow = null;
let teacherWindow = null;

// A standing human is roughly 3-4x taller than wide. A square window
// (the old 320x320) forces the camera to crop either the head or the
// feet to fit that shape — hence "only half the body showing". Portrait
// dimensions let the model's full bounding box actually fit on screen.
// Hoisted to module scope (not just local to createTeacherWindow) so the
// move-by/set-position handlers below can re-assert this exact size on
// every call — see the "growing while walking" note near those handlers.
const TEACHER_WIN_WIDTH = 130;
const TEACHER_WIN_HEIGHT = 220;

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
}

// The floating teacher lives in its own transparent, frameless,
// always-on-top window so it can sit on top of Word, a browser, or
// anything else — a normal in-app panel can't escape the main window's
// bounds. It's click-through everywhere except the avatar itself is
// dragged via the "-webkit-app-region: drag" CSS region declared in
// TeacherOverlay's markup.
function createTeacherWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  teacherWindow = new BrowserWindow({
    width: TEACHER_WIN_WIDTH,
    height: TEACHER_WIN_HEIGHT,
    x: width - TEACHER_WIN_WIDTH - 40,
    y: height - TEACHER_WIN_HEIGHT - 40,
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

  // `resizable: false` is supposed to make this a no-op guarantee, but in
  // practice the window's actual pixel content size was measured (via the
  // renderer's own canvas.width/height) to keep climbing continuously for
  // as long as the autonomous walk loop kept calling setPosition() —
  // something in the OS/window-manager layer was renegotiating size on
  // every move despite the flag, and it never snapped back on its own.
  // Belt-and-suspenders fix: whenever a 'resize' event fires for ANY
  // reason, immediately force the size back to the fixed dimensions
  // rather than trusting resizable:false alone to prevent it.
  teacherWindow.on('resize', () => {
    if (!teacherWindow) return;
    const [w, h] = teacherWindow.getSize();
    if (w !== TEACHER_WIN_WIDTH || h !== TEACHER_WIN_HEIGHT) {
      const [x, y] = teacherWindow.getPosition();
      teacherWindow.setBounds({ x, y, width: TEACHER_WIN_WIDTH, height: TEACHER_WIN_HEIGHT });
    }
  });

  // Transparent + frameless does NOT make a window click-through by
  // itself — without this call the window's full rectangle (including
  // the fully transparent pixels around the avatar) still captures every
  // mouse event at the OS level, which is why hovering anywhere over the
  // little window blocked clicks/scrolls to whatever app was underneath
  // it. `forward: true` keeps mousemove/mouseenter/mouseleave reaching
  // the renderer even while ignoring, so it can still detect when the
  // cursor is actually over the character (see TeacherOverlay.tsx) and
  // temporarily disable ignoring for that case.
  teacherWindow.setIgnoreMouseEvents(true, { forward: true });

  if (isDev) {
    teacherWindow.loadURL('http://localhost:5173/teacher.html');
  } else {
    teacherWindow.loadFile(path.join(__dirname, '..', 'dist', 'teacher.html'));
  }

  // This window has no visible chrome to right-click on, so open devtools
  // unconditionally (not just in dev) — otherwise asset/render errors here
  // fail completely silently and just show as "nothing appeared".
  teacherWindow.webContents.openDevTools({ mode: 'detach' });
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

  // The one content-editing exception, scoped entirely to the VS Code
  // bridge extension over localhost — see vscodeBridge.cjs. Every handler
  // here just forwards to that module and lets its own errors (bridge not
  // running, no file open, etc.) surface as rejected promises, which the
  // renderer turns into a spoken explanation rather than a crash.
  ipcMain.handle('vscode:isConfigured', () => vscodeBridge.isConfigured());
  ipcMain.handle('vscode:getContext', () => vscodeBridge.getContext());
  ipcMain.handle('vscode:replaceFile', (_event, filePath, content) =>
    vscodeBridge.replaceFile(filePath, content),
  );
  ipcMain.handle('vscode:insertAtCursor', (_event, content) =>
    vscodeBridge.insertAtCursor(content),
  );
  ipcMain.handle('vscode:getDiagnostics', () => vscodeBridge.getDiagnostics());

  // Relay: main app window says "I'm speaking" / "I'm done" -> forwarded
  // to the teacher overlay window so its avatar can animate accordingly.
  ipcMain.on('teacher:speak-state', (_event, speaking) => {
    teacherWindow?.webContents.send('teacher:speak-state', speaking);
  });

  // Relay: the tiny "Talk to me" button lives in the teacher overlay
  // window, but the actual call/mic/voice logic lives in the main
  // window's React tree. The main window is already running in the
  // background (it's created at startup, just like this one) — we only
  // need to tell it to start a call, not show or focus it, so the user
  // only ever sees/hears the floating character, not the app window.
  ipcMain.on('teacher:start-call', () => {
    mainWindow?.webContents.send('teacher:start-call');
  });

  // Relay: the main window tells the teacher overlay what it just did
  // (opened an app, applied a VS Code edit, etc.) so the avatar can walk
  // over and show a short caption — see TeacherOverlay.tsx.
  ipcMain.on('teacher:announce', (_event, text) => {
    teacherWindow?.webContents.send('teacher:announce', text);
  });

  // Lets the overlay's drag handle move the actual OS window, since a
  // frameless transparent window has no native title bar to drag by.
  // setBounds() (rather than setPosition()) also re-asserts the fixed
  // width/height on every move — see the createTeacherWindow 'resize'
  // watchdog note on why we no longer trust size to just stay put.
  // Values are validated first since these native bindings throw
  // (crashing the whole main process, not just this handler) given
  // anything other than finite integers.
  ipcMain.on('teacher:move-by', (_event, dx, dy) => {
    if (!teacherWindow) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = teacherWindow.getPosition();
    teacherWindow.setBounds({
      x: Math.round(x + dx),
      y: Math.round(y + dy),
      width: TEACHER_WIN_WIDTH,
      height: TEACHER_WIN_HEIGHT,
    });
  });

  // Lets the overlay's autonomous walk logic know how far it can roam
  // (screen work area) and where it currently sits, so it can pick a
  // random destination on-screen without wandering off it. Reports the
  // fixed constants rather than teacherWindow.getSize() — that call can
  // momentarily reflect a drifted size in the brief window between an
  // unexpected resize and the 'resize' watchdog correcting it.
  ipcMain.handle('teacher:get-bounds', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const [x, y] = teacherWindow ? teacherWindow.getPosition() : [0, 0];
    return { screenWidth: width, screenHeight: height, x, y, winWidth: TEACHER_WIN_WIDTH, winHeight: TEACHER_WIN_HEIGHT };
  });

  // Same finite-number guard as teacher:move-by — this one sets an
  // absolute position (used by the walk loop, every animation frame
  // while walking) rather than a delta. setBounds pins width/height back
  // to the fixed size on every single frame, which is what actually
  // stops the continuous growth: the walk loop calls this dozens of
  // times per second, so re-asserting size here closes the gap fast
  // regardless of what's causing the drift upstream.
  ipcMain.on('teacher:set-position', (_event, x, y) => {
    if (!teacherWindow) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    teacherWindow.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: TEACHER_WIN_WIDTH,
      height: TEACHER_WIN_HEIGHT,
    });
  });

  // Renderer-driven click-through toggle. `ignore: false` while the
  // cursor is actually over the rendered avatar (or while dragging it) so
  // it stays interactive; `ignore: true` the rest of the time so clicks
  // fall through to the app underneath instead of hitting this window.
  ipcMain.on('teacher:set-ignore-mouse', (_event, ignore) => {
    if (!teacherWindow) return;
    teacherWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
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
