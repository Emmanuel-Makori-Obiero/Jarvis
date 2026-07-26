// Client side of the Jarvis <-> VS Code bridge. This is the ONLY place in
// the Electron app that can read or change file contents in another
// application — every other app on the allowed-apps list can only be
// opened or closed (see appControl.cjs). That exception exists solely for
// this one connection, to this one extension, over localhost.
//
// This file never writes the token or port itself — it only reads the
// handshake file that the VS Code extension writes on activation. If that
// file isn't there, or nothing answers on the port it names, we report
// "not connected" rather than guessing or retrying against other ports.

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const BRIDGE_FILE = path.join(os.tmpdir(), "jarvis-vscode-bridge.json");
const CONNECT_TIMEOUT_MS = 2000;

function readHandshake() {
  try {
    const raw = fs.readFileSync(BRIDGE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.port !== "number" || typeof parsed.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Sends one command and resolves with its result. Opens a fresh short-lived
// connection per call rather than holding a persistent socket — voice
// commands are infrequent enough that reconnect overhead doesn't matter,
// and it means a stale/dead connection never lingers between edits.
function sendCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const handshake = readHandshake();
    if (!handshake) {
      reject(
        new Error(
          "The VS Code bridge extension isn't running. Open VS Code with the Jarvis Bridge extension started, then try again.",
        ),
      );
      return;
    }

    const socket = net.createConnection({ host: "127.0.0.1", port: handshake.port });
    let buffer = "";
    let authed = false;
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(new Error("Timed out talking to the VS Code bridge. Is VS Code still open?"));
    }, CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ token: handshake.token }) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (!authed) {
          if (msg.ok) {
            authed = true;
            socket.write(JSON.stringify({ id: 1, cmd, args: args || {} }) + "\n");
          } else {
            finish(new Error("The VS Code bridge rejected the connection. Try restarting it."));
          }
          continue;
        }

        if (msg.ok) finish(null, msg.result);
        else finish(new Error(msg.error || "The VS Code bridge returned an error."));
      }
    });

    socket.on("error", (err) => {
      finish(new Error(`Couldn't reach the VS Code bridge: ${err.message}`));
    });
  });
}

module.exports = {
  isConfigured: () => readHandshake() !== null,
  getContext: () => sendCommand("getContext", {}),
  replaceFile: (filePath, content) => sendCommand("replaceFile", { filePath, content }),
  insertAtCursor: (content) => sendCommand("insertAtCursor", { content }),
  getDiagnostics: () => sendCommand("getDiagnostics", {}),
};
