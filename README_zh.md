# Codex Hub

[English](README.md) · 简体中文

Codex Hub 为 Codex CLI 配置原生状态栏，并提供 Claude HUD 风格的终端多行面板。

## 显示效果

### Codex 输入框下方的状态栏

安装后重新打开 `codex`。输入框下方由 Codex 绘制，固定为使用 `·` 分隔的单行。预设包含模型与推理档位、项目、Git 分支、Codex 版本、上下文用量、5 小时和每周剩余额度、输入与输出词元数、任务进度，以及符合条件的企业工作区会话估算费用。Codex 会省略暂无数据的字段。下面是 Codex CLI 0.170.0 新会话的实际示例。

```text
gpt-6.2 default · codex-hub · 0.170.0 · Context 0% used · 0 in · 0 out
```

### 多行 HUD

安装后，在另一个终端进入同一项目目录运行 `watch`。想在同一个标签页查看，可用 WSL 中的 tmux 或 Windows Terminal 将标签页水平拆成上下两个窗格。上方照常运行 `codex`，下方进入同一项目目录运行 `watch`。[Windows PowerShell 命令](#使用-codex-hub)

```bash
node "${CODEX_HOME:-$HOME/.codex}/codex-hub/bin/codex-hub.mjs" watch
```

面板会在有数据时显示进度条、环境计数，以及最近的工具、MCP 调用、子代理和计划。Skills 一行显示 Codex 明确记录的已选技能。可在源码或解压目录运行 `node ./bin/codex-hub.mjs preview`，离线查看下方的内置示例。

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

上下文显示已用比例。额度显示剩余比例，有重置时间时展示倒计时。内存取自当前环境可见的系统用量，例如 WSL。词元总数取自 Codex 的累计记录，在数据齐全时分别显示非缓存输入、输出和缓存输入。企业工作区在 Codex 提供估算费用时会显示该值。

多行布局参考了 Claude HUD，以及 agy-hud 对齐 Claude HUD 并扩充默认显示的改动。[Claude HUD](https://github.com/jarrodwatts/claude-hud) · [agy-hud 对齐提交](https://github.com/yuwenlong/agy-hud/commit/3a585b5376f42685d8a21f83342ceb34f0f76d10) · [agy-hud 完整默认面板提交](https://github.com/yuwenlong/agy-hud/commit/54c25a60950bb0717910492d37af0fa53384b3dc)

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

安装器会从 GitHub 最新正式发行版下载 `codex-hub.zip`，解压到临时目录，再将运行文件安装到 `$CODEX_HOME/codex-hub`，默认为 `~/.codex/codex-hub`。安装器会在 Codex 配置目录中保存 `tui.status_line` 的原值，并通过本地 Codex app-server 更新该设置。再次运行同一条命令即可升级，随后重新打开 `codex`。如果实际设置和备份都仍匹配 v0.1.0 或 v0.1.1 的预设，升级会应用新预设并保留最初备份，以便卸载时恢复。升级也会保留您自行修改过或没有匹配备份的状态栏。

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

按 `Ctrl+C` 退出 `watch`。它每 2.5 秒查询一次本地记录，Codex 写入记录后即可看到更新。将输出重定向到文件时，`watch` 只写一份快照。

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

[Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) · [MIT 许可证](LICENSE)
