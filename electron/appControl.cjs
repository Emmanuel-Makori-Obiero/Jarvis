// The whitelist is the entire security model for open_app/close_app. An
// entry only ever gets added here through promptAddAllowedApp(), which
// requires the native OS "choose a file" dialog — a real user picking a
// real app on their own machine. There is no function here that accepts a
// path or app name from the renderer directly.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app, dialog, shell } = require("electron");
const { exec } = require("child_process");

function storePath() {
  return path.join(app.getPath("userData"), "allowed-apps.json");
}

function loadWhitelist() {
  try {
    const raw = fs.readFileSync(storePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // No file yet, or it's corrupt — either way, start from an empty list
    // rather than crashing the app over a whitelist file.
    return [];
  }
}

function saveWhitelist(list) {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save the allowed-apps whitelist:", err);
  }
}

function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

// The name used to find/kill a running process later. This is a best
// effort, not a guarantee: most apps' process name matches their filename,
// but some (notably some Electron-based apps) run under a generic internal
// name like "Electron" rather than their product name. If closing an app
// silently does nothing, that mismatch is almost always why — there's no
// general fix for it short of the user telling us the real process name.
function deriveProcessName(targetPath) {
  const base = path.basename(targetPath);
  return base.replace(/\.(exe|app)$/i, "");
}

function listAllowedApps() {
  return loadWhitelist().map(({ id, label }) => ({ id, label }));
}

// Opens the native "choose an application" dialog. Returns the newly added
// {id, label}, or null if the user cancelled.
async function promptAddAllowedApp(parentWindow) {
  const properties =
    process.platform === "darwin"
      ? ["openFile", "openApplicationBundle"]
      : ["openFile"];
  const filters =
    process.platform === "win32"
      ? [{ name: "Applications", extensions: ["exe"] }]
      : undefined;

  const result = await dialog.showOpenDialog(parentWindow ?? undefined, {
    title: "Choose an application to allow",
    properties,
    filters,
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const targetPath = result.filePaths[0];
  const label = path.basename(targetPath).replace(/\.(exe|app)$/i, "");
  const entry = {
    id: makeId(),
    label,
    path: targetPath,
    processName: deriveProcessName(targetPath),
    platform: process.platform,
  };

  const list = loadWhitelist();
  list.push(entry);
  saveWhitelist(list);
  return { id: entry.id, label: entry.label };
}

function removeAllowedApp(id) {
  const list = loadWhitelist().filter((a) => a.id !== id);
  saveWhitelist(list);
}

function findEntry(id) {
  return loadWhitelist().find((a) => a.id === id) ?? null;
}

async function openAllowedApp(id) {
  const entry = findEntry(id);
  if (!entry) {
    return {
      ok: false,
      message: "That app isn't on the allowed list anymore.",
    };
  }
  try {
    // shell.openPath launches a file/app the same way double-clicking it
    // would — on macOS that correctly starts a .app bundle, on Windows an
    // .exe, on Linux it depends on the desktop environment's file
    // associations (an AppImage or a .desktop file both tend to work; a
    // bare ELF binary sometimes doesn't, depending on the distro).
    const err = await shell.openPath(entry.path);
    if (err) {
      console.error("shell.openPath error:", err);
      return { ok: false, message: `Couldn't open ${entry.label}: ${err}` };
    }
    return { ok: true, message: `Opened ${entry.label}.` };
  } catch (e) {
    console.error("openAllowedApp failed:", e);
    return { ok: false, message: `Couldn't open ${entry.label}.` };
  }
}

// This force-closes the app the same way ending its task/force-quitting it
// would — there is no cross-platform "ask it to quit gracefully by name"
// API, so any unsaved work in that app is lost. The UI surfaces this before
// the fact; this function just executes it.
function closeAllowedApp(id) {
  const entry = findEntry(id);
  if (!entry) {
    return Promise.resolve({
      ok: false,
      message: "That app isn't on the allowed list anymore.",
    });
  }
  return new Promise((resolve) => {
    const name = entry.processName;
    let cmd;
    if (process.platform === "win32") {
      cmd = `taskkill /IM "${name}.exe" /F`;
    } else if (process.platform === "darwin") {
      cmd = `pkill -x "${name}"`;
    } else {
      cmd = `pkill -f "${name}"`;
    }
    exec(cmd, (error) => {
      if (error) {
        // taskkill/pkill exit non-zero when nothing matched — almost always
        // because the app just wasn't running, not a real failure.
        resolve({
          ok: true,
          message: `${entry.label} wasn't running, or is already closed.`,
        });
        return;
      }
      resolve({ ok: true, message: `Closed ${entry.label}.` });
    });
  });
}

module.exports = {
  listAllowedApps,
  promptAddAllowedApp,
  removeAllowedApp,
  openAllowedApp,
  closeAllowedApp,
};
