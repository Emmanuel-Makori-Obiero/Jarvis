// Jarvis VS Code Bridge
//
// This extension's entire job is to let the Jarvis desktop app read the
// currently open file and apply edits to it — nothing more. It never
// reaches out anywhere itself; it only *listens* on 127.0.0.1 (never on
// 0.0.0.0, so nothing off this machine can ever reach it) and waits for
// Jarvis's own Electron process to connect.
//
// Auth: on activation we generate a random token and write it, together
// with the port we ended up listening on, to a file in the OS temp
// directory that only this local user account can read. Jarvis reads that
// same file to know how to connect and what token to present. Any process
// that can't read that file (i.e. isn't running as this same user, on this
// same machine) can't talk to this server at all.
//
// Protocol: newline-delimited JSON over a plain TCP socket. First line
// from the client must be {"token": "..."}; every line after that is
// {"id": <n>, "cmd": "...", "args": {...}} and gets exactly one
// {"id": <n>, "ok": true, "result": ...} or {"id": <n>, "ok": false,
// "error": "..."} line back.

const vscode = require("vscode");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const BRIDGE_FILE = path.join(os.tmpdir(), "jarvis-vscode-bridge.json");
const PORT_RANGE_START = 47823;
const PORT_RANGE_TRIES = 20;

let server = null;
let statusBarItem = null;

function writeBridgeFile(port, token) {
  try {
    fs.writeFileSync(
      BRIDGE_FILE,
      JSON.stringify({ port, token, pid: process.pid }),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch (err) {
    console.error("Jarvis bridge: failed writing handshake file:", err);
  }
}

function clearBridgeFile() {
  try {
    fs.unlinkSync(BRIDGE_FILE);
  } catch {
    // Fine if it's already gone.
  }
}

// ---- Command handlers: the ONLY things a connected client can ask for ----

function activeEditorOrThrow() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error("No file is open in VS Code right now.");
  return editor;
}

async function cmdGetContext() {
  const editor = vscode.window.activeTextEditor;
  const openFiles = vscode.workspace.textDocuments
    .filter((d) => !d.isUntitled && d.uri.scheme === "file")
    .map((d) => d.uri.fsPath);

  if (!editor) {
    return { activeFile: null, openFiles, selectionText: null, fullText: null, languageId: null };
  }
  const doc = editor.document;
  const selection = editor.selection;
  return {
    activeFile: doc.uri.fsPath,
    languageId: doc.languageId,
    openFiles,
    fullText: doc.getText(),
    selectionText: selection.isEmpty ? null : doc.getText(selection),
    cursorLine: selection.active.line,
  };
}

// Full-file replace. Simplest reliable primitive for a voice-driven flow —
// no line/character math that a spoken instruction could get subtly wrong.
async function cmdReplaceFile(args) {
  const targetPath = args && args.filePath;
  const editor = targetPath
    ? await (async () => {
        const doc = await vscode.workspace.openTextDocument(targetPath);
        return vscode.window.showTextDocument(doc);
      })()
    : activeEditorOrThrow();

  const doc = editor.document;
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(doc.getText().length),
  );
  await editor.edit((builder) => {
    builder.replace(fullRange, String(args.content ?? ""));
  });
  await doc.save();
  return { filePath: doc.uri.fsPath, saved: true };
}

// Inserts text at the current cursor position (or replaces the current
// selection, if there is one) in the active editor.
async function cmdInsertAtCursor(args) {
  const editor = activeEditorOrThrow();
  const text = String(args.content ?? "");
  await editor.edit((builder) => {
    if (!editor.selection.isEmpty) {
      builder.replace(editor.selection, text);
    } else {
      builder.insert(editor.selection.active, text);
    }
  });
  await editor.document.save();
  return { filePath: editor.document.uri.fsPath, saved: true };
}

async function cmdGetDiagnostics() {
  const all = vscode.languages.getDiagnostics();
  const out = [];
  for (const [uri, diags] of all) {
    for (const d of diags) {
      out.push({
        file: uri.fsPath,
        line: d.range.start.line,
        severity: vscode.DiagnosticSeverity[d.severity],
        message: d.message,
      });
    }
  }
  return { diagnostics: out.slice(0, 200) };
}

const HANDLERS = {
  ping: async () => ({ pong: true }),
  getContext: cmdGetContext,
  replaceFile: cmdReplaceFile,
  insertAtCursor: cmdInsertAtCursor,
  getDiagnostics: cmdGetDiagnostics,
};

function startServer() {
  const token = crypto.randomBytes(24).toString("hex");

  const attempt = (portIndex) => {
    const port = PORT_RANGE_START + portIndex;
    const srv = net.createServer((socket) => {
      let authed = false;
      let buffer = "";

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          handleLine(socket, line, authed, (ok) => {
            authed = ok;
          });
        }
      });

      socket.on("error", () => {});
    });

    srv.on("error", (err) => {
      if (err.code === "EADDRINUSE" && portIndex < PORT_RANGE_TRIES) {
        attempt(portIndex + 1);
      } else {
        console.error("Jarvis bridge: could not bind a port:", err);
      }
    });

    // Bind explicitly to loopback only — this must never be reachable from
    // any other machine on the network.
    srv.listen(port, "127.0.0.1", () => {
      server = srv;
      writeBridgeFile(port, token);
      if (statusBarItem) statusBarItem.text = `$(radio-tower) Jarvis bridge: listening`;
    });
  };

  function handleLine(socket, line, authed, setAuthed) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (!authed) {
      if (msg && msg.token === token) {
        setAuthed(true);
        socket.write(JSON.stringify({ ok: true, hello: true }) + "\n");
      } else {
        socket.write(JSON.stringify({ ok: false, error: "bad token" }) + "\n");
        socket.destroy();
      }
      return;
    }

    const { id, cmd, args } = msg || {};
    const handler = HANDLERS[cmd];
    if (!handler) {
      socket.write(JSON.stringify({ id, ok: false, error: `Unknown command: ${cmd}` }) + "\n");
      return;
    }
    handler(args || {})
      .then((result) => {
        socket.write(JSON.stringify({ id, ok: true, result }) + "\n");
      })
      .catch((err) => {
        socket.write(JSON.stringify({ id, ok: false, error: String(err && err.message ? err.message : err) }) + "\n");
      });
  }

  attempt(0);
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  statusBarItem.text = "$(radio-tower) Jarvis bridge: starting…";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("jarvisBridge.status", () => {
      vscode.window.showInformationMessage(
        server ? "Jarvis bridge is listening for the Jarvis app." : "Jarvis bridge is not running.",
      );
    }),
  );

  startServer();
}

function deactivate() {
  if (server) {
    server.close();
    server = null;
  }
  clearBridgeFile();
}

module.exports = { activate, deactivate };
