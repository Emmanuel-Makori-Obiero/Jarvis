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

  // Used by the main chat window to tell the floating teacher overlay
  // when Jarvis starts/stops talking, so its avatar can animate.
  setTeacherSpeaking: (speaking) =>
    ipcRenderer.send("teacher:speak-state", speaking),

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
});
