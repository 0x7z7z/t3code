# Premiere Assistant

Premiere Assistant is a dockable CEP extension backed by this T3 Code fork. It uses
T3 conversations, account selection, approvals, and orchestration. Its install
includes the Premiere MCP server, and the extension runs the Premiere bridge itself.

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

Restart Premiere and open **Window > Extensions > Premiere Assistant**. The
assistant starts its local backend, pairs the panel, and runs its bridge
automatically. There is no second panel to start or temp directory to type. The
installer creates a private bridge directory at `~/.premiere-pro-mcp/axis-bridge` by
default; `--bridge-dir` selects another private path. Its accounts and conversations
use a separate data directory; it does not change an existing T3 installation.

Choose **Accounts** to finish provider setup in T3's browser interface, then return
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
Closing the panel keeps its backend and running tasks alive. Use normal T3 server
management to restart that dedicated backend after reinstalling, so new sessions
use the updated connector configuration, or to stop it when it is no longer needed.

## Compatibility

The CEP manifest targets Premiere 25.x and later, including 25.3. This development
build still requires testing in the exact installed Premiere version. UXP-only
editing tools require the separate UXP connector and Premiere 25.6 or later.

The editing interface targets CEP 12's Chromium 99 engine and reuses T3's shared
connection and orchestration runtime. Account setup opens T3's full interface in
your browser. This is an initial integration, not a signed distributable release.
