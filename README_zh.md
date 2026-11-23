# Codex Hub

[English](README.md) · 简体中文

Codex Hub 在 Codex CLI 的输入框正下方显示多行 HUD。按下方说明安装并加载对应 shell 的启动入口，然后像平时一样运行下面的命令。

```sh
codex
```

![Codex 输入框正下方的空闲 HUD](docs/hud-idle.png)

*图为隔离 WSL 会话中实际运行的 Codex CLI 0.170.0。*

Codex 记录了活动后，相应的行才会出现。HUD 在终端里的 Codex CLI 中运行。Codex 桌面应用和 IDE 扩展使用各自的界面。

## 在线安装

请将 Node.js 22 或更新版本及 Codex CLI 放在 `PATH` 中。Linux、macOS 和 WSL 的安装器还使用 Bash、`curl` 和 `unzip`。Windows 请使用 PowerShell 5.1 或更新版本。GitHub 发行包自带 x64 和 arm64 的终端依赖。

### Bash 或 Zsh（Linux、macOS、WSL）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.sh)
```

安装器会自动配置当前 shell 的启动入口。安装后新开终端即可直接运行 `codex`，若要在当前已打开的终端立即启用，请运行 `. "${CODEX_HOME:-$HOME/.codex}/codex-hub/scripts/activate.sh"`。升级时重新运行上述短命令即可（若使用自定义 `CODEX_HOME`，请先执行 `export CODEX_HOME=...`）。已有终端仍显示原生单行时，可查看[排障步骤](#诊断与显式启动)。

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.ps1 | iex
```

安装结束后，新开一个交互式 PowerShell 窗口并运行 `codex`。

### Windows CMD

```cmd
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.ps1 | iex"
```

CMD 可以运行安装器。新开交互式 PowerShell 后，直接输入 `codex` 即可启动 HUD。继续使用 CMD 时，运行下面的显式启动命令。

```cmd
set "CODEX_HUB_CLI=%USERPROFILE%\.codex\codex-hub\bin\codex-hub.mjs"
if defined CODEX_HOME set "CODEX_HUB_CLI=%CODEX_HOME%\codex-hub\bin\codex-hub.mjs"
node "%CODEX_HUB_CLI%" launch --
```

安装器从 GitHub 最新正式发行版下载 `codex-hub.zip`，并将运行文件放在 `$CODEX_HOME/codex-hub`，默认为 `~/.codex/codex-hub`。若使用自定义 `CODEX_HOME`，请在运行安装器、卸载器等命令前导出该变量，安装、启动和卸载都使用同一个值。

下载发行包遇到临时连接故障或 HTTP 429、503 等响应时，安装器会自动重试。如果开头的脚本下载失败，重新运行同一条命令即可。

Bash 和 Zsh 的在线命令会为运行它的 shell 配置启动入口。Windows 使用当前用户的 PowerShell 全宿主配置文件。已有的 `codex` 别名和函数优先。重新运行同一条安装命令可以升级。首次安装时若想手动启动，可导出 `CODEX_HUB_SHELL=none` 后安装，再使用[显式启动命令](#诊断与显式启动)。若当前终端已加载 Codex Hub，设置 `CODEX_HUB_SHELL=none` 并重装后可新开终端，或在当前 Bash 或 Zsh 运行 `CODEX_HUB_BYPASS=1 codex`。

如果在已经加载旧版启动入口的终端中升级，并使用自定义配置目录，请在这个终端运行 `export CODEX_HOME` 后再启动 `codex`。

## 使用 HUD

输入 `codex` 新建会话。运行 `codex resume` 可选择会话，也可以直接指定会话 ID 恢复。启动器调用 `PATH` 上的 Codex，界面覆盖仅对本次启动生效。`codex exec`、`codex app-server`、帮助和没有终端的调用保持原生行为。显式指定 `--no-alt-screen`、`--remote`，或为本次启动自定义终端标题或状态栏时，也会走原生 CLI。

Codex CLI 0.170.0 对带命令行界面覆盖的会话使用内嵌的 app-server。若本次需要沿用原有的共享后台服务器设置，可在 Bash 或 Zsh 运行 `CODEX_HUB_BYPASS=1 codex`，或在 PowerShell 运行 `& (Get-Command codex -CommandType Application | Select-Object -First 1).Source`。

基础行显示当前模型与推理档位、工作区与 Git 分支、Codex 版本、上下文用量和系统内存。终端支持 OSC 8 时，可点击工作区名称打开本地目录。内存取自 Codex 所处环境，例如 WSL。记录用量后会出现词元行，有数据时区分非缓存输入、输出和缓存输入。当前回合的一条文本响应完成并记下可配对的用量和时段后，词元行会显示最近输出速率（`tok/s`），按文本输出耗时估算，扣除推理词元。符合条件的企业会话在 Codex 提供估算费用时会显示该值。

使用官方 OpenAI 提供方的会话会显示本机 Codex app-server 返回的额度分组。只有一组时，额度仍放在上下文旁边。多组额度显示在活动行下方，标出组名，进度条按剩余比例填充、按已用比例着色。有重置时间时显示倒计时。账户额度不可用时，使用会话记录或原生状态栏中已有的额度。截图来自 WSL 中实际运行的 Codex CLI，额度使用符合官方格式的受控响应。[分组额度示例](docs/hud-quotas.png)

![Codex 输入框下显示工具和子代理的 HUD](docs/hud-active.png)

*图为同一 Codex CLI 实际运行画面，子代理事件与 23% 上下文来自受控的本机会话记录。*

- 工具和 MCP 活动取自最近一轮。每个 MCP 服务器只出现一次，有失败会标记。Skills 行显示 Codex 明确记录的已选技能。
- HUD 为每个正在运行的子代理单独显示一行，已完成的子代理不予显示。名字、模型、推理档位和耗时取自已有的代理事件。子代理行先显示派单任务，再显示可查到的最近活动。Codex 未公开派单正文时，有启动记录的任务名会标为「任务名」。
- 任务行采用原生状态栏中 `update_plan` 的进度计数。环境行统计生效的 `AGENTS.md`、已启用的 MCP 服务器和钩子，以及本地 app-server 返回的内联 `[agents.<name>]` 角色。命名配置档可能使环境计数不可用。没有数据的字段和空活动行会省略。

多行布局参考了 Claude HUD，以及 agy-hud 对齐样式和启用完整面板的改动。[Claude HUD](https://github.com/jarrodwatts/claude-hud) · [agy-hud 对齐提交](https://github.com/yuwenlong/agy-hud/commit/3a585b5376f42685d8a21f83342ceb34f0f76d10) · [agy-hud 完整面板提交](https://github.com/yuwenlong/agy-hud/commit/54c25a60950bb0717910492d37af0fa53384b3dc)

## 诊断与显式启动

未加载 shell 接入配置时，也可以显式启动。用 `doctor` 检查当前生效的状态栏设置，`status` 打印一次活动快照，`watch` 每 2.5 秒刷新一次，`preview` 查看示例数据。对话框打开或终端太窄时，Codex 会回到原生显示。

### Bash 或 Zsh

安装或重开 Codex 后仍看到 `model · project · branch ...` 原生单行时，先在 Codex 中运行 `/exit`，从退出时打印的恢复命令中复制会话 ID。若已安装 v0.2.2 或更新版本，且当前终端与安装时配置的 shell 和启动文件一致，在原终端运行以下命令，将 `SESSION_ID` 替换为刚复制的 ID。

```bash
if [ -n "${CODEX_HOME-}" ]; then export CODEX_HOME; fi
. "${CODEX_HOME:-$HOME/.codex}/codex-hub/scripts/activate.sh" && codex resume SESSION_ID
```

使用旧版、当前 shell 与安装时配置的 shell 不一致、已有优先的 `codex` 别名或函数，或者加载后仍显示原生单行时，可通过显式启动命令恢复会话。

```bash
command env "CODEX_HOME=${CODEX_HOME:-$HOME/.codex}" \
  node "${CODEX_HOME:-$HOME/.codex}/codex-hub/bin/codex-hub.mjs" launch -- resume SESSION_ID
```

```bash
codex_hub_cli="${CODEX_HOME:-$HOME/.codex}/codex-hub/bin/codex-hub.mjs"
node "$codex_hub_cli" launch --
node "$codex_hub_cli" doctor
node "$codex_hub_cli" status
node "$codex_hub_cli" watch --cwd "/path/to/my project"
node "$codex_hub_cli" preview
```

### PowerShell

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$codexHubCli = Join-Path $codexHome 'codex-hub\bin\codex-hub.mjs'
node "$codexHubCli" launch --
node "$codexHubCli" doctor
node "$codexHubCli" status
node "$codexHubCli" watch --cwd 'C:\Projects\My Project'
node "$codexHubCli" preview
```

`status` 和 `watch` 支持 `--thread SESSION_ID`。两个选项 `--thread` 和 `--cwd` 都省略时，会选择 `CODEX_THREAD_ID` 指定的会话，未设置时查找当前目录最近的主会话。按 `Ctrl+C` 停止 `watch`。重定向到文件时只写一份快照。

## 在线卸载

### Bash 或 Zsh（Linux、macOS、WSL）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/yuwenlong/codex-hub/main/uninstall.sh)
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/uninstall.ps1 | iex
```

### Windows CMD

```cmd
powershell -NoProfile -Command "irm https://raw.githubusercontent.com/yuwenlong/codex-hub/main/uninstall.ps1 | iex"
```

卸载器清理受管的启动入口与运行文件。状态栏仍由 Codex Hub 管理时会还原备份，后来手动改过的值会保留。结束后请新开 shell。若安装或卸载被强制终止且重试提示锁仍存在，请确认相关进程已经退出，删除报错路径指向的空锁目录，然后重试原命令。

存在完整的本地安装时，卸载器会直接使用本地文件。如果需要下载发行包来恢复不完整的安装，卸载器会自动重试临时故障。

## 从 ZIP 手动安装

解压 `codex-hub.zip`，进入解压出的 `codex-hub` 目录。`CODEX_HOME` 设置与在线安装相同。[下载 codex-hub.zip](https://github.com/yuwenlong/codex-hub/releases/latest/download/codex-hub.zip)

### Bash 或 Zsh

```bash
node ./scripts/manage.mjs install
```

### PowerShell

```powershell
$env:CODEX_HUB_PS_PROFILE = $PROFILE.CurrentUserAllHosts
node .\scripts\manage.mjs install
```

## 开发和测试

在源码目录用 `npm ci --ignore-scripts` 准备依赖。之后直接在交互终端中从源码目录运行一条命令，就能看到当前代码的 HUD。

```sh
node ./bin/codex-hub.mjs launch --
```

这条命令会从当前源码目录启动本机已安装的 Codex，运行期间自动刷新活动数据。修改渲染代码后重新运行该命令即可看到变化，无需发布到 npm。

```sh
npm test
npm run test:integration
```

集成测试以 Codex CLI 0.170.0 为验证基准，使用含空格和中文的临时配置目录与工作目录。[Tests 工作流](https://github.com/yuwenlong/codex-hub/actions/workflows/test.yml)

## Star History

<a href="https://www.star-history.com/?repos=yuwenlong%2Fcodex-hub&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=yuwenlong/codex-hub&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=yuwenlong/codex-hub&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=yuwenlong/codex-hub&type=date&legend=top-left" />
 </picture>
</a>

[Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) · [MIT 许可证](LICENSE)
