# Axis

Axis, the editing agent, is a dockable Premiere Pro extension with conversations,
account selection, approvals, and orchestration. Its install includes the Premiere
MCP server, and the extension runs the Premiere bridge itself.

## Install the development extension

Build this fork, then install the extension:

```powershell
vp i
vp run --filter t3 build
node scripts/premiere-extension.mjs
```

The installer uses the prebuilt connector in `build/premiere-connector`. For a
development build without that bundle, it builds one from the compiled sibling
checkout at `../premiere-pro-mcp-aftr`. Use `--connector-root <checkout>` to rebuild
from another compiled checkout, or `--connector-bundle <directory>` to install a
prebuilt bundle. The checkout is needed only when building the bundle, never when
running the installed extension.

Restart Premiere and open **Window > Extensions > Axis**. Axis
starts its local backend, pairs the panel, and runs its bridge
automatically. There is no second panel to start or temp directory to type. The
installer creates a private bridge directory at `~/.premiere-pro-mcp/axis-bridge` by
default; `--bridge-dir` selects another private path. Its accounts and conversations
use `%LOCALAPPDATA%\Axis` on Windows or `~/Library/Application Support/Axis` on macOS.
When upgrading, the installer moves the previous `PremiereAssistant` data directory
to `Axis` if the backend is stopped and `Axis` does not already exist. If the backend
is running or the move fails, it keeps using the previous directory and prints a
note. Accounts and conversations are preserved. An existing `Axis` directory takes
precedence; the directories are never merged. An explicit `--data-dir` uses that
directory directly. The installer removes the previous CEP installation only when
its manifest identifies it as the old extension, preventing duplicate panels.

Choose **Accounts** to finish provider setup in Axis's browser interface, then return
to the panel and choose the editing workspace and **New edit**. Select the account and model in the composer. Codex and Claude receive the
bundled Premiere connector directly from the installed host when running in the editing
workspace, including when Codex does not trust local project configuration. The
installer also writes local MCP configuration for standalone use. Other providers need their
normal MCP configuration pointed at the installed connector and bridge directory.

Each request includes the current project, sequence, frame rate, and playhead.
The panel re-reads that context before sending. Context is a planning aid; the
editing agent must inspect the host before changing the timeline. Multiple agents
may research and review, while one agent owns timeline edits.

The installer accepts `--port`, `--data-dir`, `--bridge-dir`, and `--destination`. Use `--dry-run`
to check paths and generated MCP configuration without building or installing.
Run it again after updating the panel files; pass `--connector-root` when updating
the connector server too. Existing extension-owned MCP entries migrate to the
bundled server on reinstall.
Closing the panel keeps its backend and running tasks alive. Restart that dedicated
backend after reinstalling so new sessions use the updated connector configuration.
Stop it when it is no longer needed.

## Compatibility

The CEP manifest targets Premiere 25.x and later, including 25.3. This development
build still requires testing in the exact installed Premiere version. UXP-only
editing tools require the separate UXP connector and Premiere 25.6 or later.

The editing interface targets CEP 12's Chromium 99 engine. Account setup opens
Axis's full interface in your browser. This is an initial integration, not a signed
distributable release.

## About

Axis is built on an open-source T3 Code fork.
