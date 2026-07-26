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
});
