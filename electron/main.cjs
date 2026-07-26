// Electron main process.
//
// This is the ONLY process with access to Node's filesystem and child-process
// APIs. The renderer (your existing React app) never gets that access
// directly — it only talks to this file through the narrow, whitelisted
// bridge exposed in preload.cjs. That separation is what makes it safe to
// let a voice/LLM-driven UI trigger native app launches at all: the model
// can ask, but only this process can act, and only within the saved
// whitelist.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const appControl = require("./appControl.cjs");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#030507", // matches the app's own background — avoids a white flash on launch
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, // renderer cannot reach Node/Electron internals directly
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    // `npm run electron:dev` sets this — points at the running Vite dev
    // server so you get hot reload during development.
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    // Production: load the static build produced by `vite build`.
    // Adjust this path if your build output directory isn't `dist`.
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Any link the renderer tries to open as a real new OS-level browser
  // window (there shouldn't be any left, since open_link now uses the
  // in-app Browser panel) gets handed to the system browser instead of
  // spawning a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    // macOS convention: clicking the dock icon with no windows open should
    // reopen one, rather than doing nothing.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS convention: apps normally stay running (in the dock) after the
  // last window closes, until the user explicitly quits. Everywhere else,
  // closing the last window quits the app.
  if (process.platform !== "darwin") app.quit();
});

// ---- IPC handlers: the only door between the renderer and the OS ----
// Every one of these delegates straight to appControl.cjs, which enforces
// the whitelist. Nothing here accepts an arbitrary path or command from the
// renderer — open/close only ever take an `id` that must already exist in
// the saved whitelist.

ipcMain.handle("apps:list", async () => {
  return appControl.listAllowedApps();
});

ipcMain.handle("apps:add", async () => {
  // Opens a native "choose an application" dialog — the ONLY way an app
  // gets onto the whitelist. There is no IPC channel that lets the
  // renderer add an app by just passing a path or name.
  return appControl.promptAddAllowedApp(mainWindow);
});

ipcMain.handle("apps:remove", async (_event, id) => {
  return appControl.removeAllowedApp(id);
});

ipcMain.handle("apps:open", async (_event, id) => {
  return appControl.openAllowedApp(id);
});

ipcMain.handle("apps:close", async (_event, id) => {
  return appControl.closeAllowedApp(id);
});
