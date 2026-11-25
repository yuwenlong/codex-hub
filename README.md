# Codex HUD

English · [简体中文](README_zh.md)

Codex HUD adds a multi-line HUD directly below the Codex CLI input box. Follow the installation steps for your shell, then run your usual command.

```sh
codex
```

![The Codex input box with the idle HUD directly below it](docs/hud-idle.png)

*Captured from Codex CLI 0.170.0 in an isolated WSL session. All three screenshots use the original terminal captures with the workspace name updated to `codex-hud`.*

Activity rows appear as Codex records them. The HUD runs in a terminal with Codex CLI. The Codex desktop app and IDE extension have their own displays.

## Install online

Put Node.js 22 or later and Codex CLI on `PATH`. On Linux, macOS, and WSL, the installer also uses Bash, `curl`, and `unzip`. On Windows, use PowerShell 5.1 or later. The GitHub release bundles the terminal dependencies for x64 and arm64.

If you are upgrading from Codex Hub, follow the [migration steps](#migrate-from-codex-hub) first.

### Bash or Zsh (Linux, macOS, WSL)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/yuwenlong/codex-hud/main/scripts/install.sh)
```

The installer configures your shell automatically. Open a new terminal after installation and run `codex`, or run `. "${CODEX_HOME:-$HOME/.codex}/codex-hud/scripts/activate.sh"` to enable it immediately in the current terminal. Run the same command again to upgrade (if you use a custom `CODEX_HOME`, run `export CODEX_HOME=...` first). See [diagnostics](#diagnostics-and-explicit-launcher) if an existing shell still shows the single-line footer.

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/yuwenlong/codex-hud/main/scripts/install.ps1 | iex
```

Open a new interactive PowerShell window after installation and run `codex`.

### Windows CMD

```cmd
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/yuwenlong/codex-hud/main/scripts/install.ps1 | iex"
```

CMD can run the installer. Open a new interactive PowerShell session for automatic `codex` activation, or run the explicit launcher from CMD.

```cmd
set "CODEX_HUD_CLI=%USERPROFILE%\.codex\codex-hud\bin\codex-hud.mjs"
if defined CODEX_HOME set "CODEX_HUD_CLI=%CODEX_HOME%\codex-hud\bin\codex-hud.mjs"
node "%CODEX_HUD_CLI%" launch --
```

The installer downloads `codex-hud.zip` from the latest published GitHub release and installs the runtime under `$CODEX_HOME/codex-hud`, which defaults to `~/.codex/codex-hud`. Export a custom `CODEX_HOME` before running the installer or uninstaller, using the same value for installation, launch, and removal.

The installer retries temporary connection errors and HTTP failures such as 429 or 503 while downloading the release. If the initial script download fails, run the same command again.

The Bash and Zsh command configures the shell that runs it. On Windows the installer uses the current user's all-hosts PowerShell profile. Existing `codex` aliases and functions retain priority. Run the same installation command again to update Codex HUD. For a first install with manual startup, export `CODEX_HUD_SHELL=none` and use the [explicit launcher](#diagnostics-and-explicit-launcher). If you reinstall with `CODEX_HUD_SHELL=none` after loading Codex HUD, open a new terminal or run `CODEX_HUD_BYPASS=1 codex` in the current Bash or Zsh.

If you keep an already-open terminal after an update and use a custom configuration directory, run `export CODEX_HOME` before starting `codex` there.

## Migrate from Codex Hub

Exit your Codex Hub sessions before uninstalling. Use the same `CODEX_HOME` throughout the migration. For a custom directory, export `CODEX_HOME` in Bash or Zsh or set `$env:CODEX_HOME` in PowerShell. Set it again in each fresh shell if you configure it per session.

The old uninstaller restores its saved status line if its preset is still in use and preserves later edits. Codex HUD saves the resulting status line before applying its preset. Your other Codex settings and sessions stay in the same directory. You can reapply a custom `tui.status_line` after installation to keep using it in native Codex.

### Complete installations of v0.1.1 through v0.2.6

Bash or Zsh

```bash
if [ -n "${CODEX_HOME-}" ]; then export CODEX_HOME; fi
node "${CODEX_HOME:-$HOME/.codex}/codex-hub/scripts/manage.mjs" uninstall
```

PowerShell, including when you normally launch from CMD

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
node (Join-Path $codexHome 'codex-hub\scripts\manage.mjs') uninstall
if ($LASTEXITCODE -ne 0) { throw 'Codex Hub uninstall failed.' }
```

### v0.1.0, incomplete installations, and interrupted operations

Use the old uninstaller from the [v0.2.6 release ZIP](https://github.com/yuwenlong/codex-hud/releases/download/v0.2.6/codex-hub.zip). If it reports a lock, confirm any old installer or uninstaller has exited. Remove only the empty lock directory named in the error, then rerun the old uninstaller. Use `rmdir` in Bash or Zsh or `[IO.Directory]::Delete('path from the error')` in PowerShell.

Bash or Zsh

```bash
(
  set -e
  if [ -n "${CODEX_HOME-}" ]; then export CODEX_HOME; fi
  legacy_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-hub-uninstall.XXXXXXXX")
  trap 'rm -rf -- "$legacy_dir"' EXIT
  curl -fsSL --proto-redir '=https' 'https://github.com/yuwenlong/codex-hud/releases/download/v0.2.6/codex-hub.zip' -o "$legacy_dir/codex-hub.zip"
  unzip -q "$legacy_dir/codex-hub.zip" -d "$legacy_dir"
  node "$legacy_dir/codex-hub/scripts/manage.mjs" uninstall
)
```

PowerShell

```powershell
$legacyDir = Join-Path ([IO.Path]::GetTempPath()) ('codex-hub-uninstall-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($legacyDir) | Out-Null
try {
    $archive = Join-Path $legacyDir 'codex-hub.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/yuwenlong/codex-hud/releases/download/v0.2.6/codex-hub.zip' -OutFile $archive -ErrorAction Stop
    Expand-Archive -LiteralPath $archive -DestinationPath $legacyDir -ErrorAction Stop
    node (Join-Path $legacyDir 'codex-hub\scripts\manage.mjs') uninstall
    if ($LASTEXITCODE -ne 0) { throw 'Codex Hub uninstall failed.' }
} finally {
    Remove-Item -LiteralPath $legacyDir -Recurse -Force
}
```

If the old uninstaller reports an edited launcher block or the new installer reports a leftover block, back up the startup file named in the message. Move any of your edits out of the block and remove only the lines between and including the matching `# >>> codex-hub … >>>` and `# <<< codex-hub … <<<` markers. Rerun the old uninstaller to clear its shell record.

After the old uninstaller succeeds, close the old shell. In a fresh shell, rename any `CODEX_HUB_*` options you set in your own configuration to `CODEX_HUD_*`, then follow the [Codex HUD installation steps](#install-online). Open a new shell after installation and run `codex`.

## Use the HUD

Run `codex` for a new session. Run `codex resume` to pick a session, or pass its ID to resume it directly. The launcher starts the Codex executable on `PATH` and applies display overrides to that invocation only. `codex exec`, `codex app-server`, help, and commands without a terminal use the original CLI behavior. An explicit `--no-alt-screen`, `--remote`, or custom terminal title or status line override also uses the original CLI.

Codex CLI 0.170.0 uses its embedded app-server for sessions with command-line display overrides. To use your usual shared background server settings for a session, run `CODEX_HUD_BYPASS=1 codex` in Bash or Zsh, or run `& (Get-Command codex -CommandType Application | Select-Object -First 1).Source` in PowerShell.

The compact rows show the current model and reasoning effort, workspace and Git branch, Codex version, context usage, and system memory. Terminals with OSC 8 support can open the local directory from the workspace name. Memory reflects the environment where Codex runs, including WSL. The token row appears when usage is recorded and breaks out uncached input, output, and cached input where available. Once a completed text response in the current turn has matching usage and timing records, the row shows its approximate output rate in `tok/s` using the text's duration and excluding reasoning tokens. Codex may report estimated costs for eligible Enterprise sessions.

For sessions using the official OpenAI provider, the HUD displays the quota groups reported by the local Codex app-server. A single group uses the compact quota slots beside context usage. Multiple groups appear below activity with named meters that fill by remaining quota and change color based on usage. Countdown values appear when reset times are available. When account quota data is unavailable, the HUD uses available values from the session or native footer. The screenshot was captured in the WSL CLI using a controlled response in Codex's official quota format. [Grouped quota example](docs/hud-quotas.png)

![The Codex input box with recent activity and subagents in the HUD](docs/hud-active.png)

*Captured from the same Codex CLI using a controlled local session record for the subagent events and 23% context value.*

- The latest turn supplies tool activity and MCP calls. MCP servers are listed once and failures are marked. The Skills row shows selections explicitly recorded by Codex.
- The HUD shows a separate row for each running subagent and hides finished subagents. Names, models, effort, and elapsed times come from recorded agent events when available. Each row puts the recorded assignment before the child's recent activity when both are available. If Codex withholds the assignment text, the HUD displays the recorded launch task name when available.
- Task progress follows the current `update_plan` counts from the native footer. The environment row counts effective `AGENTS.md` files, enabled MCP servers and hooks, and inline `[agents.<name>]` roles available through the local app-server. A named CLI profile can make environment counts unavailable. Codex HUD omits missing fields and empty activity rows.

The layout draws on Claude HUD and agy-hud's alignment and expanded default. [Claude HUD](https://github.com/jarrodwatts/claude-hud) · [agy-hud alignment](https://github.com/yuwenlong/agy-hud/commit/3a585b5376f42685d8a21f83342ceb34f0f76d10) · [agy-hud expanded default](https://github.com/yuwenlong/agy-hud/commit/54c25a60950bb0717910492d37af0fa53384b3dc)

## Diagnostics and explicit launcher

The explicit launcher works without shell activation. `doctor` checks the effective status line setting. `status` prints one activity snapshot, `watch` polls every 2.5 seconds, and `preview` shows sample HUD data. Codex's original display remains available when a dialog is open or the terminal is too narrow for an embedded HUD.

### Bash or Zsh

If you still see a single `model · project · branch ...` line after installing or reopening Codex, run `/exit` in Codex and copy `SESSION_ID` from the resume command that Codex prints. Run the following in the existing terminal when it matches the configured shell and startup file. Use the session ID you just copied.

```bash
if [ -n "${CODEX_HOME-}" ]; then export CODEX_HOME; fi
. "${CODEX_HOME:-$HOME/.codex}/codex-hud/scripts/activate.sh" && codex resume SESSION_ID
```

Resume with the explicit launcher if your shell differs from the configured shell, a custom `codex` alias or function takes precedence, or Codex still shows a single line after activation.

```bash
command env "CODEX_HOME=${CODEX_HOME:-$HOME/.codex}" \
  node "${CODEX_HOME:-$HOME/.codex}/codex-hud/bin/codex-hud.mjs" launch -- resume SESSION_ID
```

```bash
codex_hud_cli="${CODEX_HOME:-$HOME/.codex}/codex-hud/bin/codex-hud.mjs"
node "$codex_hud_cli" launch --
node "$codex_hud_cli" doctor
node "$codex_hud_cli" status
node "$codex_hud_cli" watch --cwd "/path/to/my project"
node "$codex_hud_cli" preview
```

### PowerShell

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$codexHudCli = Join-Path $codexHome 'codex-hud\bin\codex-hud.mjs'
node "$codexHudCli" launch --
node "$codexHudCli" doctor
node "$codexHudCli" status
node "$codexHudCli" watch --cwd 'C:\Projects\My Project'
node "$codexHudCli" preview
```

`status` and `watch` accept `--thread SESSION_ID`. Without `--thread` or `--cwd`, they use `CODEX_THREAD_ID` when set and otherwise look up the most recent main session in the current directory. Press `Ctrl+C` to stop `watch`. Redirecting it to a file writes one snapshot.

## Uninstall online

### Bash or Zsh (Linux, macOS, WSL)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/yuwenlong/codex-hud/main/uninstall.sh)
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/yuwenlong/codex-hud/main/uninstall.ps1 | iex
```

### Windows CMD

```cmd
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/yuwenlong/codex-hud/main/uninstall.ps1 | iex"
```

The uninstaller removes the managed launcher and installation. It restores a saved status line when Codex HUD still owns the setting and keeps any later edits. Open a new shell when finished. To recover from a force-stopped operation that reports a lock, confirm the installer has exited, remove the empty lock directory named in the error, and rerun the command.

The uninstaller uses a complete local installation when available. If it needs to download the release to recover an incomplete installation, it retries temporary failures.

## Install manually from ZIP

Extract `codex-hud.zip` and open the extracted `codex-hud` directory. Use the same `CODEX_HOME` as the online installer. [Download codex-hud.zip](https://github.com/yuwenlong/codex-hud/releases/latest/download/codex-hud.zip)

### Bash or Zsh

```bash
node ./scripts/manage.mjs install
```

### PowerShell

```powershell
$env:CODEX_HUD_PS_PROFILE = $PROFILE.CurrentUserAllHosts
node .\scripts\manage.mjs install
```

## Develop and test

Install the dependencies in this checkout with `npm ci --ignore-scripts`. Then launch Codex with the current code in one command, from the checkout in an interactive terminal.

```sh
node ./bin/codex-hud.mjs launch --
```

This command starts your installed Codex CLI from the checkout and refreshes activity automatically. Rerun it after editing the renderer to see the new code.

```sh
npm test
npm run test:integration
```

The integration tests use Codex CLI 0.170.0 and temporary configuration and working directories with spaces and Chinese characters. [Tests workflow](https://github.com/yuwenlong/codex-hud/actions/workflows/test.yml)

## Star History

<a href="https://www.star-history.com/?repos=yuwenlong%2Fcodex-hud&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=yuwenlong/codex-hud&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=yuwenlong/codex-hud&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=yuwenlong/codex-hud&type=date&legend=top-left" />
 </picture>
</a>

[Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli) · [MIT License](LICENSE)
