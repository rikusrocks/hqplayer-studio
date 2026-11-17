# HQPlayer Studio

> 面向 **HQPlayer Desktop 6** 的第三方现代音乐库、播放列表管理器与网页遥控器。
> HQPlayer 继续负责解码、DSP、升频（PCM→DSD512）、CUDA 与 DAC 输出；Studio 只负责“找音乐、排队、遥控”。
>
> **与 Signalyst 无任何隶属关系。** HQPlayer 是 Signalyst 的产品。

**当前阶段：Phase 5（v0.5.0）—— 稳定性与发布：安装包、数据库备份/恢复与版本回退、本地日志与崩溃报告、长时间播放测试。** 控制 HQPlayer 需在设置中开启，且只开放在你的 HQPlayer 上验证过的命令；协议能力见 [docs/protocol-capabilities.md](docs/protocol-capabilities.md)，进度见 [docs/PROGRESS.md](docs/PROGRESS.md)。

**使用说明：[用户指南 / User guide](docs/user-guide.md)**（安装、连接 HQPlayer、音乐库、遥控、DSP、备份与回退、日志、长时间播放测试）。

|                 |                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 桌面端          | Electron 45 + React 19：专辑/歌手/歌曲/文件夹浏览、搜索、播放列表、即时队列、迷你播放器（置顶、记住位置）、媒体键与托盘图标（Windows）、同步歌词、分层设置页 |
| 歌词            | 同名 `.lrc` / 文件内嵌歌词（离线）；可选在线歌词：LRCLIB / 网易云 / 酷狗 / lyrics.ovh（默认关闭，逐个开启，只查正在播放的曲目）；每首歌可校准时间偏移        |
| 网页遥控        | 手机/iPad 浏览器：正在播放 / 浏览 / 播放列表 / 队列（同一音乐库、实时同步；网页本身不播放音频）                                                              |
| Core            | Fastify REST + WebSocket、SQLite（Node 内置 `node:sqlite`）、队列编排与同步检测                                                                              |
| HQPlayer 适配器 | Mock 引擎；基于官方 SDK 6.0.1 的 TCP/XML 协议层（只读优先，写命令需真机验证后开放）                                                                          |
| 稳定性          | 自动备份数据库（升级前 + 每日）、一键恢复、拒绝打开更新版本的数据库并提供回退；本地日志与崩溃报告（脱敏、不上传）；长时间播放测试报告                        |
| 探测器          | `hqp-probe.exe`：双击运行、只读、生成脱敏 JSON 报告                                                                                                          |

## Mac 上开发

需要 Node ≥ 24.11（推荐 26，见 `.nvmrc`）和 pnpm 12。

```bash
pnpm install
```

```bash
pnpm dev
```

- 桌面界面（浏览器预览）：<http://127.0.0.1:5173/>
- 网页遥控：<http://127.0.0.1:5174/remote/>
- Core API：<http://127.0.0.1:47321/api/v1/health>

两个界面连接同一个 Core 与 Mock 引擎，可以在一个窗口里操作、在另一个窗口里看到同步变化。首次启动会自动导入虚构的演示音乐库（13 张专辑，含中/日文、多碟、合辑、同名不同格式版本）。

| 命令                                | 作用                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| `pnpm dev:electron`                 | 构建并以 Electron 窗口运行桌面端                          |
| `pnpm demo:reset`                   | 清空 `.data/dev` 并重新导入演示库                         |
| `pnpm test`                         | 全部单元/集成测试（Vitest）                               |
| `pnpm lint` · `pnpm typecheck`      | ESLint · TypeScript strict                                |
| `pnpm build`                        | 构建 remote、desktop（renderer + main + preload）与探测器 |
| `pnpm check`                        | lint + typecheck + test + build                           |
| `pnpm probe --port 4321 --no-pause` | 在本机运行只读探测器（开发用）                            |

## Windows 上运行（无需安装开发环境）

Windows 构建由 GitHub Actions（`windows-latest`）完成，打包后的程序在 CI 上自动冒烟测试（含安装版的静默安装与卸载）。

- **正式版本**：仓库的 **Releases** 页面 —— `HQPlayerStudio-<版本>-setup-x64.exe`（安装版，推荐）、
  `…-portable-x64.exe`（免安装）、`…-win-x64.zip`、`hqp-probe-<版本>-windows-x64.zip` 和 `SHA256SUMS.txt`。
- **每次修改后的测试版本**：**Actions → Windows build → 最新一次运行 → Artifacts**：
  `HQPlayerStudio-windows-x64-setup`、`HQPlayerStudio-windows-x64-portable`、`HQPlayerStudio-windows-x64-zip`、
  `hqp-probe-windows-x64`（解压即是 `hqp-probe.exe` / `hqp-gatec.exe` / `hqp-dspgate.exe` 和说明，
  见 [scripts/hqp-probe/README-WINDOWS.txt](scripts/hqp-probe/README-WINDOWS.txt)）。

首次运行默认使用 **Mock 引擎**，不会连接或改动 HQPlayer；连接真实 HQPlayer 见[用户指南](docs/user-guide.md)。
程序未签名，首次运行时 SmartScreen 可能提示：点 “更多信息” → “仍要运行”。

### 发布新版本（维护者）

1. 在 `package.json` 和 `apps/desktop/package.json` 中改版本号，更新 `docs/PROGRESS.md`，合并到 `main`。
2. 在 `main` 上打标签并推送：`git tag v<版本> && git push origin v<版本>`。
3. “Windows build” 会构建、测试、冒烟测试，然后生成一个 **草稿** Release（附 SHA256SUMS；标签与版本号不一致时失败）。
   在 GitHub 上检查后点 “Publish release”。手动运行该工作流（Run workflow）只生成 `release-preview` 产物，不创建 Release。

## 安全与原则

- 不插入音频链路、不改 HQPlayer 配置/许可证；断线重连后**不会自动播放、改音量或改 DSP**。
- 只连接 `127.0.0.1:4321`；Core 默认只监听本机。局域网遥控默认关闭：在 设置 → 网页遥控 中开启后，只在你选择的
  家庭局域网地址（192.168.x / 10.x / 172.16–31.x）上监听，手机需输入电脑上显示的一次性配对码；令牌只以哈希保存，
  可随时在设备列表中取消配对。手机永远拿不到设置、诊断、音乐文件夹管理或本机文件路径。请勿把端口映射到公网。
- 写命令（播放、队列、音量、DSP）在 Desktop 6 上验证前一律禁用并说明原因；不支持的功能显示 “需要在 HQPlayer 原生界面设置”。
- 外部改动（HQPlayer 原生界面/其他遥控器）会被标记为“队列不一致”，由用户决定是否接管，绝不静默覆盖。
- 扫描只读文件；离线 ≠ 删除；播放列表引用的曲目不会被删除。
- 在线歌词默认关闭，每个来源（LRCLIB、网易云音乐、酷狗音乐、lyrics.ovh）单独开启；开启后只为正在播放的曲目发送歌名/歌手/专辑/时长，从不在扫描时批量查询，不发送路径或账号信息。歌词内容不进入日志和诊断信息。
- 在线封面（iTunes / Deezer / Cover Art Archive）默认关闭；开启后只发送专辑名和专辑艺人，自动查询只针对正在播放且没有封面的专辑，其它由你手动查找；已有本地封面的专辑不会被替换。

## 仓库结构

```text
apps/desktop          Electron main/preload + 桌面 UI
apps/remote           网页遥控（Core 在 /remote/ 提供）
packages/contracts    共享 DTO / zod 校验 / 事件类型
packages/core         REST + WebSocket、引擎监督、队列编排、扫描任务
packages/hqplayer-adapter  适配器接口、Mock、SDK 派生的 TCP/XML 协议层
packages/library      SQLite、迁移、仓库、扫描器、封面缓存、演示数据
packages/api-client   带校验的 API 客户端 + 自动重连 WS
packages/ui           共享组件、设计 token、i18n（中文/英文）
packages/lyrics       LRC 解析与同步、在线歌词来源（限速、尊重 429/Retry-After）
scripts/hqp-probe     只读探测器（Node SEA 单文件 exe）
fixtures/             虚构演示库；协议样本（待真机报告）
docs/                 能力矩阵、进度、架构、决策记录、测试矩阵、交接书
```

更多：[用户指南](docs/user-guide.md) · [架构](docs/architecture.md) · [决策记录](docs/decision-log.md) · [测试矩阵](docs/test-matrix.md) · [项目交接书（公开副本）](docs/handoff/HQPlayer_Studio_AI_Agent_Handoff_2026-11-10.md)

## English summary

HQPlayer Studio is an unofficial, third-party library manager, playlist editor and web remote for HQPlayer Desktop 6 — HQPlayer stays the invisible audio engine. It indexes your Windows music folders, keeps playlists and a queue, controls HQPlayer through an SDK-derived (MIT) protocol layer (only commands verified on your engine, and only after you allow control), serves a paired phone remote on the home LAN, and adds a Mini Player, media keys/tray, synced lyrics (local files first; online sources only if you opt in) and DSP changes. Since 0.5.0 it backs up its database (before updates and daily) and refuses a database from a newer version while offering the pre-update backup, keeps a redacted local log with crash reports (never uploaded), and records long listening tests. Windows builds (installer, portable, zip) come from GitHub Actions and GitHub Releases; see the [user guide](docs/user-guide.md#english). Develop on macOS with `pnpm install && pnpm dev`. MIT licensed — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
