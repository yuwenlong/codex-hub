# Codex Hub

English · [简体中文](README_zh.md)

Codex Hub configures the built-in Codex CLI status line and provides a multi-line session HUD in the style of Claude HUD.

## What you see

### Status line inside Codex

Reopen `codex` after installation to see its built-in status line below the input box. Codex draws it as one line with `·` separators. The preset includes the model and reasoning effort, project, Git branch, Codex version, context used, remaining five-hour and weekly limits, input and output token counts, and task progress. Codex shows an estimated thread cost for eligible Enterprise workspaces and skips fields without data. This example shows a fresh session in Codex CLI 0.170.0.

```text
gpt-6.2 default · codex-hub · 0.170.0 · Context 0% used · 0 in · 0 out
```

### Multi-line HUD

After installing, run `watch` from the same project directory in a second terminal. To keep both views in one tab, use tmux in WSL or Windows Terminal to split the tab into top and bottom panes. Run `codex` in the top pane and `watch` from the same project directory in the bottom pane. [Windows PowerShell commands](#use-codex-hub)

```bash
node "${CODEX_HOME:-$HOME/.codex}/codex-hub/bin/codex-hub.mjs" watch
```

The HUD shows progress bars, environment counts, recent tools, MCP calls, subagents, and plans as data becomes available. The Skills row lists the skill selections explicitly recorded by Codex. To see this built-in example offline, run `node ./bin/codex-hub.mjs preview` from the project checkout or extracted ZIP.

```text
[GPT-6.2-Astra ● max] │ codex-hub git:(main) │ Codex v0.170.0 │ ⏱ 1h 56m │ 费用 $34.95 │ 示例
上下文 ███░░░░░░░ 32% │ 5h 剩余 53% (54m) │ 7d 剩余 39% (6d 14h)
内存   █████░░░░░ 10.3 GB / 22.5 GB (46%)
2 AGENTS.md │ 6 MCPs │ 1 钩子
最近回合 进行中
✓ Shell ×20
▸ Skills (2) 已选 superpowers:systematic-debugging, ponytail:ponytail
MCPs (2) ✓ codegraph/search ×2 │ ✓ chrome-devtools/list_pages
◐ reviewer │ gpt-6.2 ● medium │ 进行中
▸ 计划 最近回合有已保存计划
词元 9.9M (输入 678k, 输出 31k, 缓存 9.2M)
```

The HUD uses Chinese labels. Context shows the percentage used. Quota shows the percentage remaining and the time until reset when available. Memory is system usage visible from the current environment, such as WSL. The token row shows the session total from Codex and separates uncached input, output, and cached input when available. The live HUD shows estimated cost when Codex reports it for an Enterprise workspace.

The layout draws on Claude HUD and agy-hud's work to match its layout and show more by default. [Claude HUD](https://github.com/jarrodwatts/claude-hud) · [agy-hud Claude HUD alignment](https://github.com/yuwenlong/agy-hud/commit/3a585b5376f42685d8a21f83342ceb34f0f76d10) · [agy-hud expanded default](https://github.com/yuwenlong/agy-hud/commit/54c25a60950bb0717910492d37af0fa53384b3dc)

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

The installer downloads `codex-hub.zip` from the latest published GitHub release, extracts it in a temporary directory, and installs the runtime in `$CODEX_HOME/codex-hub`, which defaults to `~/.codex/codex-hub`. It saves the previous `tui.status_line` value in your Codex configuration directory and updates the setting through the local Codex app-server. Run the same install command again to upgrade, then reopen `codex`. If your footer and backup still match the v0.1.0 or v0.1.1 preset, the upgrade applies the new preset and keeps your original footer for uninstall. It preserves your custom footer and any legacy settings without a matching backup.

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

Press `Ctrl+C` to exit `watch`. It polls local records every 2.5 seconds. Updates appear after Codex writes them. Redirecting `watch` output to a file writes a single snapshot.

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

[Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli) · [MIT License](LICENSE)
