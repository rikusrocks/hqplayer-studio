# HQPlayer Studio

> 面向 **HQPlayer Desktop 6** 的第三方现代音乐库、播放列表管理器与网页遥控器。
> HQPlayer 继续负责解码、DSP、升频（PCM→DSD512）、CUDA 与 DAC 输出；Studio 只负责“找音乐、排队、遥控”。
>
> **与 Signalyst 无任何隶属关系。** HQPlayer 是 Signalyst 的产品。

**当前阶段：Phase 0 —— 可运行的 Mock 原型 + Windows 只读探测器。** 尚未在真实 HQPlayer 上执行任何控制命令；协议能力见 [docs/protocol-capabilities.md](docs/protocol-capabilities.md)，进度见 [docs/PROGRESS.md](docs/PROGRESS.md)。

|                 |                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| 桌面端          | Electron 45 + React 19：专辑/歌手/歌曲/文件夹浏览、搜索、播放列表、即时队列、迷你播放器、设置与能力矩阵 |
| 网页遥控        | 手机/iPad 浏览器：正在播放 / 浏览 / 播放列表 / 队列（同一音乐库、实时同步；网页本身不播放音频）         |
| Core            | Fastify REST + WebSocket、SQLite（Node 内置 `node:sqlite`）、队列编排与同步检测                         |
| HQPlayer 适配器 | Mock 引擎；基于官方 SDK 6.0.1 的 TCP/XML 协议层（只读优先，写命令需真机验证后开放）                     |
| 探测器          | `hqp-probe.exe`：双击运行、只读、生成脱敏 JSON 报告                                                     |

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

Windows 构建由 GitHub Actions（`windows-latest`）完成。到仓库的 **Actions → Windows build → 最新一次运行 → Artifacts** 下载：

- `HQPlayerStudio-windows-x64`：`HQPlayerStudio-<版本>-portable-x64.exe`（免安装）或 `.zip`。Phase 0 使用 **Mock 引擎**，不会连接或改动 HQPlayer。
- `hqp-probe-windows-x64`：`hqp-probe.exe` + 说明。先打开 HQPlayer，再双击探测器，把生成的 `hqp-probe-report-*.json` 发回即可。详见 [scripts/hqp-probe/README-WINDOWS.txt](scripts/hqp-probe/README-WINDOWS.txt)。

程序未签名，首次运行时 SmartScreen 可能提示：点 “更多信息” → “仍要运行”。

## 安全与原则

- 不插入音频链路、不改 HQPlayer 配置/许可证；断线重连后**不会自动播放、改音量或改 DSP**。
- 只连接 `127.0.0.1:4321`；Core 默认只监听本机。局域网遥控默认关闭：在 设置 → 网页遥控 中开启后，只在你选择的
  家庭局域网地址（192.168.x / 10.x / 172.16–31.x）上监听，手机需输入电脑上显示的一次性配对码；令牌只以哈希保存，
  可随时在设备列表中取消配对。手机永远拿不到设置、诊断、音乐文件夹管理或本机文件路径。请勿把端口映射到公网。
- 写命令（播放、队列、音量、DSP）在 Desktop 6 上验证前一律禁用并说明原因；不支持的功能显示 “需要在 HQPlayer 原生界面设置”。
- 外部改动（HQPlayer 原生界面/其他遥控器）会被标记为“队列不一致”，由用户决定是否接管，绝不静默覆盖。
- 扫描只读文件；离线 ≠ 删除；播放列表引用的曲目不会被删除。

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
packages/lyrics       LRC 解析（LRCLIB 在 P1）
scripts/hqp-probe     只读探测器（Node SEA 单文件 exe）
fixtures/             虚构演示库；协议样本（待真机报告）
docs/                 能力矩阵、进度、架构、决策记录、测试矩阵、交接书
```

更多：[架构](docs/architecture.md) · [决策记录](docs/decision-log.md) · [测试矩阵](docs/test-matrix.md) · [项目交接书（公开副本）](docs/handoff/HQPlayer_Studio_AI_Agent_Handoff_2026-11-10.md)

## English summary

HQPlayer Studio is an unofficial, third-party library manager, playlist editor and web remote for HQPlayer Desktop 6 — HQPlayer stays the invisible audio engine. Phase 0 delivers a runnable Electron + web prototype driven by a mock engine, an SDK-derived (MIT) protocol layer that is read-only by default, and a single-file Windows probe that produces a sanitised capability report. Develop on macOS with `pnpm install && pnpm dev`; Windows builds come from GitHub Actions. MIT licensed — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
