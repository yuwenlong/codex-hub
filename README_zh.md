# Codex Hub

[English](README.md) · 简体中文

Codex Hub 为 Codex CLI 配置原生状态栏，并提供一个终端视图查看会话活动。

- **状态栏**在有数据时显示模型及推理档位、项目、Git 分支、上下文使用率、5 小时及每周剩余额度和任务进度。
- **活动视图**在另一个终端显示最近回合的工具、子代理状态和已保存的计划。`watch` 每 2.5 秒查询一次，Codex 写入记录后即可看到更新。

## 在线安装

请将 `node`（Node.js 22 或更新版本）和 `codex`（Codex CLI）放在 `PATH` 中。Linux、macOS 和 WSL 使用 Bash、`curl` 和 `unzip`。Windows 使用 PowerShell 5.1 或更新版本。

### Bash（Linux、macOS、WSL）

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

安装器会从 GitHub 最新正式发行版下载 `codex-hub.zip`，解压到临时目录，再将运行文件安装到 `$CODEX_HOME/codex-hub`，默认为 `~/.codex/codex-hub`。安装器会在 Codex 配置目录中保存 `tui.status_line` 的原值，并通过本地 Codex app-server 更新该设置。重新打开 `codex` 即可看到状态栏。再次运行同一条安装命令即可升级。

如果您已使用自定义 Codex 配置目录，安装、运行和卸载 Codex Hub 时都沿用现有的 `CODEX_HOME`。

## 使用 Codex Hub

`doctor` 检查当前生效的状态栏设置，`status` 显示活动快照。在项目目录运行 `watch` 可以持续查看活动，也可以用 `--cwd` 指定项目，或用 `--thread` 指定会话 ID。省略这两个参数时，如果设置了 `CODEX_THREAD_ID` 就使用该会话，否则查找当前工作目录下最近的主会话。

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

按 `Ctrl+C` 退出 `watch`。将输出重定向到文件时，`watch` 只写一份快照。活动视图通过本地 app-server 读取会话记录，显示工具类型、状态等元数据。

`preview` 可以离线预览活动视图。终端视图使用中文标签。

```text
Codex Hub 示例 codex-hub | gpt-6.2 (high) | git:main
会话 preview | 最近回合 进行中
工具 Shell | 1 进行中 · 2 完成
代理 reviewer | gpt-6.2 (medium) | 进行中
计划 最近回合有已保存计划
```

## 在线卸载

卸载器先还原备份的状态栏设置，再移除受管安装。若安装后手动改过状态栏，卸载器会保留您后来设置的值。您可以留存手动解压的文件。重新打开 `codex` 即可看到结果。

### Bash（Linux、macOS、WSL）

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

如果安装或卸载被强制终止，且重试时提示锁仍存在，请确认 Codex Hub 的安装和卸载进程均已退出，删除报错路径所指的空锁目录，再运行原命令恢复操作并保留手动解压的文件。

## 从 ZIP 手动安装

下载发行 ZIP 后，在包含该文件的目录运行下列命令。[下载 codex-hub.zip](https://github.com/yuwenlong/codex-hub/releases/latest/download/codex-hub.zip)

### Bash（Linux、macOS、WSL）

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

安装后重新打开 `codex`。用这里设置的脚本路径运行 `doctor`、`watch` 等命令。要还原手动安装修改的状态栏，在 Bash 中运行 `node "$codex_hub_cli" uninstall`，或在 PowerShell 中运行 `node "$codexHubCli" uninstall`，然后重新打开 `codex`。

## 测试

```bash
npm test
npm run test:integration
```

集成测试以 Codex CLI 0.170.0 为验证基准，需要可从 `PATH` 调用的 `codex`。测试使用含空格及中文的临时配置和工作目录。手动触发工作流即可运行 Linux、macOS 和 Windows 检查。[Tests 工作流](https://github.com/yuwenlong/codex-hub/actions/workflows/test.yml)

终端用法参考了 Claude HUD 和 agy-hud。[Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) · [Claude HUD](https://github.com/jarrodwatts/claude-hud) · [agy-hud](https://github.com/yuwenlong/agy-hud) · [MIT 许可证](LICENSE)
