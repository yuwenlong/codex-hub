# Codex Hub

Codex Hub 为 Codex CLI 配置原生状态栏，并提供一个终端视图查看会话活动。项目参考 Claude HUD 和 agy-hud 的终端用法，适用于使用 `codex` 命令的工作流。

- **Codex 原生状态栏**随主窗口更新，显示模型及推理档位、项目、Git 分支、上下文使用率、5 小时及每周剩余额度和任务进度。字段随会话和账号可用数据出现。
- **活动视图**在另一个终端查看最近回合的工具、子代理状态和计划记录。`watch` 每 2.5 秒查询 Codex 已保存的会话活动，显示时延取决于 Codex 写入记录的时间。

运行 `preview` 可以离线预览活动视图。

```text
Codex Hub 示例 codex-hub | gpt-6.2 (high) | git:main
会话 preview | 最近回合 进行中
工具 Shell | 1 进行中 · 2 完成
代理 reviewer | gpt-6.2 (medium) | 进行中
计划 最近回合有已保存计划
```

## 安装

需要 Node.js 22 或更新版本，并将 `node` 和 `codex` 放在 `PATH` 中。首版以 Codex CLI 0.170.0 为验证基准。下载 [codex-hub.zip](https://github.com/yuwenlong/codex-hub/releases/latest/download/codex-hub.zip) 后，在包含 ZIP 的目录执行下列命令。

### Linux、macOS 和 WSL

```sh
unzip codex-hub.zip
codex_hub_cli="$PWD/codex-hub/bin/codex-hub.mjs"
node "$codex_hub_cli" install
```

### Windows PowerShell

```powershell
$codexHubRoot = Join-Path $env:LOCALAPPDATA 'Codex Hub'
Expand-Archive -LiteralPath .\codex-hub.zip -DestinationPath $codexHubRoot
$codexHubCli = Join-Path $codexHubRoot 'codex-hub\bin\codex-hub.mjs'
node $codexHubCli install
```

安装后重新打开 `codex`。安装器通过本地 Codex app-server 更新用户配置中的 `tui.status_line`，并在 Codex 配置目录中保存该字段的原值。若已设置 `CODEX_HOME`，就使用该目录。可用 `doctor` 查看当前生效的字段配置，用 `uninstall` 还原安装前的设置。若安装后手动修改过状态栏，卸载后继续使用您后来设置的值。

## 查看会话活动

在需要查看的项目目录运行 `status` 或 `watch`。也可以用 `--cwd` 指定工作目录，或用 `--thread` 指定会话 ID。当未指定参数且环境中有 `CODEX_THREAD_ID` 时，使用该会话。其余情况下按当前工作目录查找最近的主会话。请将示例中的脚本路径指向实际解压位置。

```sh
node "$codex_hub_cli" preview
node "$codex_hub_cli" status
node "$codex_hub_cli" watch --cwd "/path/to/my project"
node "$codex_hub_cli" watch --thread "会话 ID"
node "$codex_hub_cli" doctor
node "$codex_hub_cli" uninstall
```

PowerShell 示例使用带空格的工作路径。

```powershell
node $codexHubCli preview
node $codexHubCli doctor
node $codexHubCli watch --cwd 'C:\Projects\My Project'
node $codexHubCli uninstall
```

按 `Ctrl+C` 退出 `watch`。将输出重定向到文件时，`watch` 只写一份快照。活动视图通过本地 app-server 读取会话记录，输出工具类型、状态等元数据。

## 测试

```sh
npm test
npm run test:integration
```

集成测试需要可从 `PATH` 调用的 Codex CLI。测试使用含空格及中文的临时配置和工作目录。仓库的 [Tests 工作流](https://github.com/yuwenlong/codex-hub/actions/workflows/test.yml) 可手动运行 Linux、macOS 和 Windows 检查。

参考 [Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli)、[Claude HUD](https://github.com/jarrodwatts/claude-hud) 和 [agy-hud](https://github.com/yuwenlong/agy-hud)。本项目使用 [MIT 许可证](LICENSE)。
