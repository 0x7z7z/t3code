# Axis Windows installer

Build on Windows x64 after installing the repository's pinned pnpm dependencies. No administrator access or preinstalled NSIS is required:

```powershell
node scripts/build-axis-installer.mjs
node --test extensions/premiere/*.test.cjs
$axisBuild = Get-Content dist/axis-installer/build-report.json | ConvertFrom-Json
node scripts/test-axis-installer.mjs $axisBuild.executable
```

The build runs the server and web build, stages their output and runtime dependency closure, and produces one `Axis-<version>-<content-hash>-Setup.exe` plus an unpacked payload and `build-report.json` under `dist/axis-installer`. Use `--skip-build` after an existing successful `vp run --filter t3 build`. Connector inputs accept the same `--connector-root` / `--connector-bundle` options as the dev installer. `--output` and `--cache` select build directories.

Node 24.22.1 comes from nodejs.org, MinGit 2.56.0.3 from Git for Windows, and the portable NSIS 3.11 compiler from the NSIS release archive. Every archive has a pinned SHA-256 checked before extraction, including cached downloads. Packages are resolved from the installed pnpm dependency graph and copied without links. Preserve dependency license notices when redistributing the payload. NSIS supplies a native per-user setup wizard, silent operation, and a normal Windows uninstaller without an additional runtime or admin installation on the build machine.

Users run the executable, restart Premiere Pro 2024/2025, and open **Window > Extensions > Axis**. Runtime files live under `%LOCALAPPDATA%\Programs\Axis\app-<build-id>`; CEP files live under `%APPDATA%\Adobe\CEP\extensions\Axis`. Setup enables `PlayerDebugMode=1` under HKCU for CSXS.10 through CSXS.12 because this CEP bundle is unsigned. ZXP signing can replace that development-mode requirement in a later release; Authenticode signing of the setup executable is a separate release step.

Installations retain existing backend/workspace paths. Without an existing configuration, the same Axis/PremiereAssistant directory selection as the dev installer applies. Existing conversation data is never renamed or moved. A small `.axis-install.json` workspace receipt lets a reinstall update owned MCP paths after the CEP folder was uninstalled. Uninstall removes packaged runtimes and the owned CEP panel, leaves workspace/data/bridge directories intact, and stops only backend PIDs recorded by those runtimes after verifying executable and entrypoint identity. Development backends are never stopped by that cleanup. Close Premiere before uninstalling so its panel cannot restart a backend during removal.

The panel reuses a protocol-1 backend already on its configured port, including a development backend. New starts use the packaged Node/server, with portable Node and Git on the child process PATH. Failed backends restart while the panel is open. A shared startup lease prevents separate CEP contexts from spawning competing backends. An incompatible or unresponsive service produces an error instead of another process. Upgrades use a new content-addressed runtime folder; an already running compatible backend remains active until its next restart. The existing `/premiere-extension.json` protocol-1 signal is unchanged; `release.json` in the installed runtime records the build ID and pinned assets.

For a direct sandbox install, supply every target explicitly:

```powershell
$env:AXIS_SANDBOX_ROOT = Join-Path $env:USERPROFILE 'axis-manual-test'
$env:AXIS_RUNTIME_DIR = Join-Path $env:AXIS_SANDBOX_ROOT 'Programs/Axis'
$env:AXIS_CEP_DIR = Join-Path $env:AXIS_SANDBOX_ROOT 'Roaming/Adobe/CEP/extensions/Axis'
$env:AXIS_DATA_DIR = Join-Path $env:AXIS_SANDBOX_ROOT 'Local/Axis'
$env:AXIS_WORKSPACE_DIR = Join-Path $env:AXIS_DATA_DIR 'workspace'
$env:AXIS_BRIDGE_DIR = Join-Path $env:AXIS_SANDBOX_ROOT 'User/axis-bridge'
$env:AXIS_SKIP_REGISTRY = '1'
& $axisBuild.executable /S /SANDBOX /PORT=5843
```

The root and runtime overrides select isolation before extraction. Missing overrides or a missing registry skip fail closed. NSIS first extracts only a private bootstrap Node and guard to its temporary plugin directory. That guard resolves every target and existing descendant before any payload is extracted to the selected install directory. It runs again after the directory page, and on uninstall. The guard rejects live CEP, PremiereAssistant data, Axis runtime and `~/.premiere-pro-mcp` paths, their parents, and links escaping the sandbox. The helper also validates inherited configuration paths, and the dev installer validates its final effective paths in sandbox mode. Sandbox mode skips Adobe settings and uninstall registration. The smoke test compares protected live configuration files and registry values before and after execution.

Windows can quote an entire `/NAME=value` argument containing spaces; NSIS `GetOptions` can ignore that form. The earlier attempt fell through to the live `$LOCALAPPDATA\Programs\Axis` default, extracted its runtime there, then used the live CEP default and its existing workspace configuration. That rewrote the live panel and the workspace's owned MCP settings. Sandbox selection now uses environment overrides and detects raw `/SANDBOX` intent without regard to case before choosing defaults. Any partial sandbox environment fails closed. The smoke test accepts only an installer whose matching build report records sandbox protocol 3 and its SHA-256, so it refuses earlier unsafe binaries. `/PORT` defaults to 5739 for normal installs and sandbox runs must use a spare port. Standard NSIS `/D=...` can override the runtime directory and must be the last argument. Do not use sandbox paths inside a live install; clear `AXIS_*` test environment variables before performing a real installation. Silent sandbox uninstall requires the same explicit `AXIS_*` environment as installation.

`test-axis-installer.mjs` creates a temporary directory under the user's home outside the checkout, uses a spare ephemeral port, seeds a simulated dev install with legacy data, runs the actual setup executable, and starts its packaged backend with system Node/Git and repo module paths absent from the environment. The home directory is intentional: the connector rejects shared writable ancestors such as a shared system temp directory. The test checks the protocol endpoint, served CEP web entry and script, pairing CLI, concurrent starts, crash recovery, same-version repair while running, uninstall with an owned backend, retained data, and reinstall. It prints its sandbox path and preserves a log there. Protected live CEP/configuration files and registry settings must remain byte-for-byte unchanged.

Release acceptance still needs a fresh Windows VM with Premiere 2024/2025: dock the panel, authenticate a provider through the existing account flow, and perform an editing request. Automated packaging tests do not prove Adobe host behavior, external provider authentication, SmartScreen reputation, or signing.
