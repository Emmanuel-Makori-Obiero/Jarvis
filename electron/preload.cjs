// Preload script — runs in an isolated context with access to Node APIs,
// but the renderer (your React app) only ever sees what's explicitly
// exposed here via contextBridge. This is the entire surface area the web
// UI has for talking to the OS: five functions, each mapping to one IPC
// channel handled in main.cjs. Nothing else leaks through.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  listAllowedApps: () => ipcRenderer.invoke("apps:list"),
  addAllowedApp: () => ipcRenderer.invoke("apps:add"),
  removeAllowedApp: (id) => ipcRenderer.invoke("apps:remove", id),
  openApp: (id) => ipcRenderer.invoke("apps:open", id),
  closeApp: (id) => ipcRenderer.invoke("apps:close", id),

  // The one exception to "open/close only" — scoped entirely to VS Code,
  // and entirely to the local bridge extension (see electron/vscodeBridge.cjs
  // and vscode-extension/). Nothing here can touch any other app's files.
  vscode: {
    isConfigured: () => ipcRenderer.invoke("vscode:isConfigured"),
    getContext: () => ipcRenderer.invoke("vscode:getContext"),
    replaceFile: (filePath, content) =>
      ipcRenderer.invoke("vscode:replaceFile", filePath, content),
    insertAtCursor: (content) => ipcRenderer.invoke("vscode:insertAtCursor", content),
    getDiagnostics: () => ipcRenderer.invoke("vscode:getDiagnostics"),
  },

  // Used by the main chat window to tell the floating teacher overlay
  // when Jarvis starts/stops talking, so its avatar can animate.
  setTeacherSpeaking: (speaking) =>
    ipcRenderer.send("teacher:speak-state", speaking),

  // Used by the teacher overlay's own tiny "Talk to me" button: asks the
  // main window to start a call. Used by the main window to listen for it.
  requestStartCall: () => ipcRenderer.send("teacher:start-call"),
  onStartCallRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("teacher:start-call", handler);
    return () => ipcRenderer.removeListener("teacher:start-call", handler);
  },

  // Used by the main window to tell the teacher overlay what it just did,
  // so the avatar can walk over and show a short caption bubble. Used by
  // the teacher overlay to receive that text.
  announceToTeacher: (text) => ipcRenderer.send("teacher:announce", text),
  onTeacherAnnounce: (callback) => {
    const handler = (_event, text) => callback(text);
    ipcRenderer.on("teacher:announce", handler);
    return () => ipcRenderer.removeListener("teacher:announce", handler);
  },

  // Used by the teacher overlay itself to receive that state, and to
  // drag its own (frameless, native-title-bar-less) window around.
  onTeacherSpeakState: (callback) => {
    const handler = (_event, speaking) => callback(speaking);
    ipcRenderer.on("teacher:speak-state", handler);
    return () => ipcRenderer.removeListener("teacher:speak-state", handler);
  },
  moveTeacherWindowBy: (dx, dy) => ipcRenderer.send("teacher:move-by", dx, dy),

  // Used by the autonomous walk state machine to know the screen's
  // work area and the overlay window's own current position/size.
  getTeacherBounds: () => ipcRenderer.invoke("teacher:get-bounds"),

  // Used by the autonomous walk loop to move the window to an absolute
  // screen position each animation frame while it "walks".
  setTeacherPosition: (x, y) => ipcRenderer.send("teacher:set-position", x, y),

  // Lets the overlay toggle its own click-through behavior: `ignore: true`
  // makes the OS pass clicks/scrolls straight through to whatever app is
  // underneath the transparent window (so hovering empty space never
  // steals focus from Word, a browser, etc). The renderer flips this
  // based on real hit-testing against the avatar mesh, not just "mouse is
  // somewhere over this window's rectangle".
  setTeacherIgnoreMouseEvents: (ignore) =>
    ipcRenderer.send("teacher:set-ignore-mouse", ignore),
});
