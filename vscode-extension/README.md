# Jarvis VS Code Bridge

This is what lets Jarvis actually read and edit code in VS Code during a
live call — it's the one exception to "open/close only, never touch
contents" in the main app, and it only applies to VS Code.

## What it does

- Listens on `127.0.0.1` only (never reachable from the network).
- Writes a one-time random token + port to
  `~/.tmp/jarvis-vscode-bridge.json` (OS temp dir) so only a process
  already running as you, on this machine, can find and use it.
- Exposes exactly four things to that local connection: read the active
  file/selection/open files, replace a file's full contents, insert text
  at the cursor, and read diagnostics (red/yellow squiggles). Nothing
  else — no terminal access, no arbitrary command execution.

## Running it (until it's packaged properly)

1. Open the `vscode-extension` folder in VS Code.
2. Press `F5` (or Run → Start Debugging). This opens a second "Extension
   Development Host" VS Code window with the bridge active — that's the
   window you should have your project open in when you want Jarvis to
   help you code.
3. You'll see "Jarvis bridge: listening" in the status bar of that
   window.

To install it permanently instead of running it via F5 every time,
package it with `npx vsce package` and install the resulting `.vsix`
via the Extensions panel's "Install from VSIX" option.

## How Jarvis uses it

In the Jarvis app, you have to explicitly say something like "open VS
Code and help me edit this" — Jarvis won't read or touch files in VS
Code just because it happens to be open. Once you've asked, Jarvis:

1. Connects to the bridge and reads whatever file you have open.
2. Talks you through changes like normal.
3. Applies edits by replacing the file's contents or inserting at your
   cursor, then saves — you'll see it happen live in the editor.

If the bridge isn't running, Jarvis will tell you to start it rather
than silently failing.
