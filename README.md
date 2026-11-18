# Codex Hub

English · [简体中文](README_zh.md)

Codex Hub configures the native Codex CLI status line and adds a terminal view for session activity.

- **Status line** shows the model and reasoning effort, project, Git branch, context usage, remaining five-hour and weekly limits, and task progress when those fields are available.
- **Activity view** shows tools, subagent status, and saved plans from the latest turn in a second terminal. `watch` polls saved activity every 2.5 seconds. Updates appear after Codex writes them.

## Install online

Put `node` (Node.js 22 or later) and `codex` (Codex CLI) on your `PATH`. Use Bash with `curl` and `unzip` on Linux, macOS, or WSL, or Windows PowerShell 5.1 or later on Windows.

### Bash (Linux, macOS, WSL)

```bash
(installer=$(curl -fsSL https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.sh) && [ -n "$installer" ] && bash -c "$installer")
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.ps1 | iex
```

### Windows CMD

```cmd
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.ps1 | iex"
```

The installer downloads `codex-hub.zip` from the latest published GitHub release, extracts it in a temporary directory, and installs the runtime in `$CODEX_HOME/codex-hub`, which defaults to `~/.codex/codex-hub`. It saves the previous `tui.status_line` value in your Codex configuration directory and updates the setting through the local Codex app-server. Reopen `codex` to see the status line. Run the same install command again to upgrade.

If you already use a custom Codex configuration directory, keep the same `CODEX_HOME` when installing, using, and uninstalling Codex Hub.

## Use Codex Hub

Run `doctor` to check the effective status line setting and `status` for a snapshot. Run `watch` from the project directory for a live view, use `--cwd` to select a project, or use `--thread` to select a session ID. With neither option, Codex Hub uses `CODEX_THREAD_ID` if it is set or looks up the most recent main session for the current working directory.

### Bash

```bash
codex_hub_cli="${CODEX_HOME:-$HOME/.codex}/codex-hub/bin/codex-hub.mjs"
node "$codex_hub_cli" doctor
node "$codex_hub_cli" status
node "$codex_hub_cli" watch
node "$codex_hub_cli" watch --cwd "/path/to/my project"
node "$codex_hub_cli" watch --thread "SESSION_ID"
node "$codex_hub_cli" preview
```

### Windows PowerShell

```powershell
$codexHome = $env:CODEX_HOME
if (-not $codexHome) { $codexHome = Join-Path $HOME '.codex' }
$codexHubCli = Join-Path $codexHome 'codex-hub\bin\codex-hub.mjs'
node "$codexHubCli" doctor
node "$codexHubCli" status
node "$codexHubCli" watch
node "$codexHubCli" watch --cwd 'C:\Projects\My Project'
node "$codexHubCli" watch --thread 'SESSION_ID'
node "$codexHubCli" preview
```

Press `Ctrl+C` to exit `watch`. Redirecting its output to a file writes a single snapshot. The activity view reads session records through the local app-server and displays metadata such as tool types and statuses.

`preview` shows the activity view offline. The terminal view uses Chinese labels.

```text
Codex Hub 示例 codex-hub | gpt-6.2 (high) | git:main
会话 preview | 最近回合 进行中
工具 Shell | 1 进行中 · 2 完成
代理 reviewer | gpt-6.2 (medium) | 进行中
计划 最近回合有已保存计划
```

## Uninstall online

The uninstaller restores the saved status line setting first, then removes the managed installation. If you edited the status line after installing, it keeps your latest setting. You can keep any manually extracted copies. Reopen `codex` to see the result.

### Bash (Linux, macOS, WSL)

```bash
(uninstaller=$(curl -fsSL https://raw.githubusercontent.com/yuwenlong/codex-hub/main/uninstall.sh) && [ -n "$uninstaller" ] && bash -c "$uninstaller")
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/uninstall.ps1 | iex
```

### Windows CMD

```cmd
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/uninstall.ps1 | iex"
```

If an install or uninstall was forcibly stopped and a retry reports a lock, confirm all Codex Hub install and uninstall processes have exited, remove the empty lock directory at the path shown in the error, and rerun the same command to recover while keeping any manually extracted files.

## Install manually from ZIP

Download the release ZIP, then run the commands below from the directory containing it. [Download codex-hub.zip](https://github.com/yuwenlong/codex-hub/releases/latest/download/codex-hub.zip)

### Bash (Linux, macOS, WSL)

```bash
unzip codex-hub.zip
codex_hub_cli="$PWD/codex-hub/bin/codex-hub.mjs"
node "$codex_hub_cli" install
```

### Windows PowerShell

```powershell
$codexHubRoot = Join-Path $env:LOCALAPPDATA 'Codex Hub'
Expand-Archive -LiteralPath .\codex-hub.zip -DestinationPath $codexHubRoot
$codexHubCli = Join-Path $codexHubRoot 'codex-hub\bin\codex-hub.mjs'
node "$codexHubCli" install
```

Reopen `codex` after installation. Reuse the script path set here for `doctor`, `watch`, and the other commands. To restore the status line for a manual installation, run `node "$codex_hub_cli" uninstall` in Bash or `node "$codexHubCli" uninstall` in PowerShell, then reopen `codex`.

## Tests

```bash
npm test
npm run test:integration
```

The integration tests use Codex CLI 0.170.0 as the test baseline and require `codex` on `PATH`. They use temporary configuration and working directories with spaces and Chinese characters. The manually triggered workflow runs checks on Linux, macOS, and Windows. [Tests workflow](https://github.com/yuwenlong/codex-hub/actions/workflows/test.yml)

The terminal workflow draws on Claude HUD and agy-hud. [Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli) · [Claude HUD](https://github.com/jarrodwatts/claude-hud) · [agy-hud](https://github.com/yuwenlong/agy-hud) · [MIT License](LICENSE)
