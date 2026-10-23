# Premiere Assistant

Premiere Assistant is a dockable CEP extension backed by this T3 Code fork. It uses
T3 conversations, account selection, approvals, and orchestration. The existing
Premiere MCP connector executes editing tools inside Premiere.

## Install the development extension

Build the existing Premiere MCP checkout, then build this fork:

```powershell
vp i
vp run --filter t3 build
node scripts/premiere-extension.mjs --connector-root D:\premiere-pro-mcp-aftr
```

Restart Premiere and open **Window > Extensions > Premiere Assistant**. Keep
**MCP for Adobe Premiere Pro** enabled. The assistant starts its own local backend
and pairs the panel automatically. Its accounts and conversations use a separate
data directory; it does not change an existing T3 installation.

In **MCP for Adobe Premiere Pro**, set **Temp directory** to the bridge path printed
by the installer (by default `~/.premiere-pro-mcp/bridge`) and start the connector.
Both panels must use the same bridge directory. Use `--bridge-dir` when your existing
connector uses a different private directory. A running Premiere application alone
does not start a stopped connector panel.

Choose **Accounts** to finish provider setup in T3's browser interface, then return
to the panel and choose the editing workspace and **New edit**. Select the account and model in the composer. Codex and Claude receive the
Premiere connector directly from the installed host when running in the editing
workspace, including when Codex does not trust local project configuration. The
installer also writes local MCP configuration for standalone use. Other providers need their
normal MCP configuration pointed at the same existing connector.

Each request includes the current project, sequence, frame rate, and playhead.
The panel re-reads that context before sending. Context is a planning aid; the
editing agent must inspect the host before changing the timeline. Multiple agents
may research and review, while one agent owns timeline edits.

The installer accepts `--port`, `--data-dir`, `--bridge-dir`, and `--destination`. Use `--dry-run`
to check paths without installing. Run it again after updating the panel files.
Closing the panel keeps its backend and running tasks alive. Use normal T3 server
management to stop that dedicated backend when it is no longer needed.

## Compatibility

The CEP manifest targets Premiere 25.x and later, including 25.3. This development
build still requires testing in the exact installed Premiere version. UXP-only
editing tools require the separate UXP connector and Premiere 25.6 or later.

The editing interface targets CEP 12's Chromium 99 engine and reuses T3's shared
connection and orchestration runtime. Account setup opens T3's full interface in
your browser. This is an initial integration, not a signed distributable release.
