> **本仓库副本说明（2026-11-10）**：这是项目交接书的公开副本，仅删除了具体的局域网 IP 地址并泛化了一处设备管理描述；其余内容与原文一致。原文是项目需求的初始唯一可信来源。

# HQPlayer Studio — 项目交接书 / AI Agent Implementation Brief

> **给接手项目的 AI Coding Agent：请先完整阅读本文件。** 这是可直接执行的产品需求文档（PRD）、技术设计草案、开发路线图、环境约束说明和验收计划。不要把它当成只有 UI 视觉要求的设计任务。无需依赖之前的聊天记录；本文件是项目上下文的初始唯一可信来源。
>
> 文档版本：`0.1` · 编写日期：`2026-11-10` · 状态：`Planning / pre-spike`  
> 暂定产品名：**HQPlayer Studio**（与 Signalyst HQPlayer 的官方产品无隶属关系；发布时应明确是第三方客户端）。  
> 项目语言：产品文档及向用户的沟通以**中文**为主；代码、标识符、提交信息、技术文档可使用英文。

---

## 0. 交给 Agent 的即时指令（先做这件事）

你是本项目的 Lead Engineer + Product-minded AI Coding Agent。**目标是做出可运行的跨平台开发项目，而不仅是输出一份计划或几张静态设计图。**

阅读本文后：

1. 检查当前工作目录是否已经有相关代码。若为空，建立 monorepo；若已有代码，在不破坏现有成果的前提下适配本规划。
2. 先建立技术骨架、领域类型、Mock 引擎、示例音乐库、基础桌面 UI 与响应式 Web Remote。**不要等待 Windows 真机连接才开始编码。**
3. 并行准备一个**只读优先**的 Windows HQPlayer API 探测工具，构建成可在 Windows 使用的测试产物，方便用户将结果以日志/JSON 带回 Mac。探测必须先使用 SDK 文档支持的命令；不得凭猜测发送不明 XML 或改写 HQPlayer 配置。
4. 制作 `docs/protocol-capabilities.md`，逐项区分 `confirmed` / `observed` / `untested` / `unsupported`，并注明实测版本、证据、限制。没有验证的 API 一律不能在应用里标为“已支持”。
5. 小步交付并保持始终可运行：每完成一个阶段，运行 lint / typecheck / unit tests / build，更新 `docs/PROGRESS.md`，列出完成项、下一项、阻碍与证据。
6. **不要擅自修改已授权的 HQPlayer 安装、许可证、音频输出配置，也不要让用户在 Windows 上安装完整开发环境。**
7. 除非任务确实涉及无法合理决定的破坏性操作，否则先根据本文做合理的工程决策，不要把大量基础问题推回给用户。

**第一批应交付的实际文件：** `README.md`、`package.json` / workspace 配置、`apps/desktop`、`apps/remote`、`packages/core`、`packages/hqplayer-adapter`、`packages/library`、`packages/contracts`、`docs/protocol-capabilities.md`、`docs/PROGRESS.md`、Windows CI 构建工作流、若干有意义的自动化测试。

---

## 1. 产品愿景

把 HQPlayer Desktop 6 变成一个**日常可用的现代音乐播放器**：HQPlayer 本身继续做音频解码、DSP、PCM→DSD 升采样、CUDA 加速及 DAC 输出；我们单独开发更现代、易用的音乐管理、播放和控制界面。

### 两个产品入口，共用一个后端

**A. HQPlayer Studio Desktop（主要产品）**

- 类似现代音乐客户端的持久音乐库：按专辑、歌手、歌曲、流派、文件夹检索与浏览。
- 可创建、保存、编辑、排序和跨会话恢复的播放列表；清晰的即时播放队列。
- 更直观的菜单与设置；区分可在线控制与需要使用 HQPlayer 原生窗口的高级设置。
- 迷你播放器，支持始终置顶、播放控制和当前歌曲信息。
- 本地/在线歌词搜索、缓存、同步滚动及手动校准。
- 高质量深色 UI，清晰的封面、搜索、播放器状态、音频格式和 DSP 信息。
- 面向 Windows 日常使用；Mac 可用于开发与 Mock 预览。

**B. HQPlayer Studio Web Remote（次要但很重要）**

- 手机、iPad 和其他浏览器打开网页即可控制 Windows 上的 HQPlayer。
- 浏览音乐库；选歌曲、选专辑；切换保存的播放列表；操作当前队列。
- 播放/暂停、上/下一首、进度、音量（若协议支持）、封面与当前歌曲信息。
- 实时同步桌面客户端状态。**网页不负责播放音频**；音频始终从 Windows 的 HQPlayer 输出。
- 支持移动端 PWA 风格交互；先保证 Safari/Chrome 响应式网页工作，再考虑原生移动端 App。

### 明确的“不做”

- 不重写 HQPlayer DSP、Filter、Modulator、NAA、CUDA 音频内核。
- 不破解、绕过或搬迁 HQPlayer 设备绑定许可证。
- 不把音频通过浏览器重新解码/重新采样/混音/串流到 DAC。
- 初期不做 Roon/Tidal/Qobuz 账户集成、音乐推荐算法、云同步或多用户账号。
- 初期不承诺 100% 替代 HQPlayer 原生深层配置界面。

---

## 2. 已知用户环境与约束（非常重要）

| 项目 | 已知情况 | 开发影响 |
|---|---|---|
| HQPlayer | 已授权 **HQPlayer Desktop 6**，安装在 Windows PC | 禁止换机激活；避免破坏配置；**具体小版本号待实机确认** |
| DSP 工作负载 | Windows 上使用 NVIDIA **RTX 5080**，常用 **DSD512** | 尽量不抢占播放时的 CPU/I/O；保持音频链完全原样 |
| 开发设备 | **Mac**，用户熟悉 JavaScript / TypeScript | 本项目以 TypeScript 为主要语言；Mac 完成日常开发 |
| Windows 开发限制 | 用户因自身环境原因**无法/不愿在 Windows 做开发** | Windows 只用于运行正式构建包、执行简单探测程序和回传日志 |
| Mac 网络策略 | 开发用 Mac 可能受到 VPN/网络安全策略约束，无法直接访问 Windows PC | 不将 Mac→Windows 网络访问作为前提；**不要绕过安全管理策略** |
| Windows HQPlayer API | 曾看到 `0.0.0.0:4321 LISTENING`，Windows 本机 `127.0.0.1:4321` TCP 测试成功 | 可优先设计 Windows 端 `localhost` API 连接；**这只证明 TCP 可达，不证明特定 API 指令可用** |
| 家庭 LAN 历史测试 | 当时 Mac `<Mac LAN IP>` → Windows `<Windows LAN IP>` 超时，Mac 的 ARP 显示 incomplete；Windows 能 ping Mac，Mac 能访问路由器 | 原因尚未确认，不能认定一定是 VPN；这些 IP 均为临时 DHCP 地址，**不能写死** |
| 安全 | Windows 曾把当前 Wi-Fi 改为 Private，添加过仅针对 Private / LocalSubnet 的 TCP 4321 入站规则 | 实际发布应优先使用 `127.0.0.1:4321`；不向公网开放原始 HQPlayer 控制协议 |
| 音乐文件 | 播放主机是 Windows；真实音乐路径/目录暂未知 | Mac 用 fixtures/Mock；真机音乐扫描需要在 Windows 本地进行，不能假设 Mac 能读取 Windows 音乐盘 |

**关键工作流：** `Mac 上开发和单测` → `CI 构建 Windows 产物` → `用户在已授权 Windows PC 上双击运行` → `生成诊断报告或验证功能` → `将报告/截图传回 Mac Agent`。

---

## 3. 官方已知能力 vs. 必须验证的假设

### 官方已确认的事实

1. Signalyst 将 Desktop 分为负责音频的 Server 和负责音乐库/控制的 Client，二者可以在不同电脑上运行；也可以由第三方应用控制。  
   官方：[Quickstart Guide](https://signalyst.com/quickstart-guide/)
2. HQPlayer Desktop **已有可扫描并保存的内置音乐库**，可以扫描目录树和远程浏览；因此“不必每次 Import”不仅可通过我们自己的数据库实现，也存在官方路径。  
   官方：[Quickstart Guide — Adding content to the library](https://signalyst.com/quickstart-guide/)
3. HQPlayer Client 已区分 **Album Mode** 与 **Playlist Mode**：专辑模式强调专辑整体连续/Gapless，队列编辑规则不同；不可简单假设任意队列操作都保持 Gapless。  
   官方：[Quickstart Guide — Playlist editor](https://signalyst.com/quickstart-guide/)
4. Signalyst 提供 **HQPlayer Control API 的参考源码/命令行工具 SDK**（官网标注对应引擎版本 6.0.1）；须以其源码和目标 Desktop 6 的实际行为为协议依据。  
   官方：[Downloads — HQPlayer SDK](https://signalyst.com/downloads/)
5. 官方列出 FLAC、DSF、DFF、WAV、WavPack、AIFF、MP3 等输入格式，以及 M3U/M3U8/PLS 等播放列表格式；我们自己的元数据解析器与 HQPlayer 真正可播放格式需要分别核验。  
   官方：[HQPlayer Desktop](https://signalyst.com/hqplayer-desktop/)

### 有参考实现/社区证据，但不能冒充 Desktop 6 实机验证

- HQPDcontrol 可作为第三方产品能力参考，包括音乐库浏览、队列管理、DSP 状态、歌词等；与我们的具体 Desktop 6 版本兼容性必须单独验证。  
  https://hqpdcontrol.alpr.cz/
- 2026 年社区帖子展示 HQPlayer 5/6 控制工具具备若干服务端播放列表命令（例如 `PlaylistGetList`、`PlaylistLoad`、`PlaylistSave`）。**这些应列入验证清单，不应直接当成我们已测试通过的能力。**  
  https://audiophilestyle.com/forums/topic/72255-playlist-name/
- 旧第三方遥控项目可参考数据流/体验，但其代码或 API 版本可能陈旧：  
  https://github.com/zeropointnine/hqpwv

### 未确认的项目风险（P0 技术验证点）

- Desktop 6 上的确切 **TCP/XML 协议封包方式**（连接生命周期、请求/响应匹配、推送/轮询、错误码、消息分帧）是什么？不要凭网上零散片段猜。
- 是否可以**可靠地加载任意 Windows 本地音频文件/专辑目录**？使用何种 URI/路径编码？是否要求先进入 HQPlayer 自带 Library？
- 是否支持：查询当前曲目与时间、seek、Next/Previous、保存/加载播放列表、编辑当前队列？哪些操作会重置/中断当前音频？
- 能否区分并切换 Album/Playlist 模式？能否稳定实现无缝专辑播放和跨专辑队列？
- 可读取和更改的 DSP 配置具体有哪些（Filter、Modulator、Rate、Matrix 等）？是否依赖播放状态？
- 是否能查询 HQPlayer 当前使用的 Windows 音乐路径，并映射到我们的数据库？
- 原生 HQPlayer/Roon/其他遥控器同时发命令时，状态和队列如何漂移？
- Desktop 6 控制 API 是否有登录/认证/加密机制或版本差异？**实际协议以官方 SDK + 实测为准。**

**底线：** API 不支持时，UI 要降级或显示 `Requires native HQPlayer settings`；不得通过危险的配置文件热修改、进程注入、UI 自动点击或内核逆向“强行实现”。

---

## 4. 优先级与 MVP 范围

### P0 / MVP（必须最先打通）

1. Windows 本机连接 HQPlayer Desktop 6；显示连接状态、当前曲目、播放状态、基本控制。
2. 让用户选一个或多个 Windows 音乐根目录，扫描、持久化、增量更新音乐库；重启后仍有专辑和曲目。
3. Desktop：专辑网格、歌手列表、歌曲列表、文件夹树、全文搜索、当前播放队列。
4. 自建可保存的播放列表 CRUD：建表、改名、删除、添加/移除/排序曲目；操作不会意外修改原列表。
5. 从 Studio 发起“播放歌曲 / 播放专辑 / 播放整个播放列表”，并与 HQPlayer 的实际状态协调。
6. Web Remote：手机访问 Windows 上的 Studio 服务，浏览、选专辑/播放列表、控制播放、显示 Now Playing。
7. 异常处理：HQPlayer 未开启、扫描目录离线、未知音频文件、断线重连、手动在 HQPlayer 原生 UI 改歌。

### P1（完成 MVP 后）

- 更完整的现代设置页，先整合经验证可读写的 DSP 参数；预设管理。
- Windows 迷你播放器，置顶、展开/收起、媒体键、托盘（能力按实际 OS 适配）。
- 歌词：内嵌/同目录 LRC → 在线 LRCLIB → 本地缓存/手动匹配；同步滚动、时间偏移。
- 更成熟的播放列表：M3U/M3U8 导入导出、最近播放、收藏、编辑操作撤销。
- 长时间播放的稳定性、封面缓存和大库搜索性能。

### P2 / 后续增强

- 高级 DSP 对比、滤波器解释和预设快捷切换。
- 多媒体库路径迁移、重复母带版本归组、快捷键自定义、歌词浮窗。
- 更丰富的音频指标/性能监控（仅在可验证和不影响播放时启用）。
- 可选 NAS/独立常驻服务部署、跨电脑连接（须遵守网络及访问权限）。

---

## 5. 目标架构（推荐，允许有充分理由的微调）

```text
                         Windows 音乐主机
  ┌────────────────────────────────────────────────────────┐
  │  HQPlayer Studio Desktop (Electron + React UI)        │
  │           │  本机受控 API / IPC                        │
  │  HQPlayer Studio Core (Node.js / TypeScript)           │
  │     ├─ Library Indexer (Windows folders / NAS)         │
  │     ├─ SQLite (music, playlists, queue, lyric cache)   │
  │     ├─ Playlist & Queue Orchestrator                   │
  │     ├─ Lyrics / Metadata / Artwork Cache              │
  │     ├─ Authenticated HTTP/WebSocket API                │
  │     └─ HQPlayer Adapter (TCP/XML)                      │
  │                    │                                  │
  │              127.0.0.1:4321                            │
  │                    ▼                                  │
  │        HQPlayer Desktop 6 (original/licensed)          │
  │                    │                                  │
  │             DSP / CUDA / ASIO / NAA → DAC              │
  │                                                        │
  │  Studio HTTP server ──────────────► Web Remote / PWA   │
  └────────────────────────────────────────────────────────┘
                   ↑  Private LAN, authenticated
           iPhone / iPad / other browser

Mac 开发机：运行 Studio 前后端 + MockHQPlayerAdapter + fixture library。
Windows 真机：运行打包产物，访问真实本地文件和真实 HQPlayer。
```

**为什么用独立 Core，而不是所有逻辑塞进 Electron Renderer？**

- 桌面 UI、Web Remote 共享业务逻辑、状态和音乐库。
- 可以单独跑服务/诊断工具；即使 UI 关闭也可按设计继续服务（后续可选）。
- 文件系统和 TCP 能力隔离在后端；前端不能直接操作 HQPlayer 原始控制端口。
- 未来 Electron 换为 Tauri / 原生 Shell 时，业务核心仍可复用。

### 推荐技术选择

- **Monorepo**：pnpm workspaces（或等价工具），TypeScript strict，ESLint、Prettier、Vitest。
- **Desktop**：Electron + React + Vite。选择 Electron 是因为 Windows 原生窗口、迷你模式、系统托盘、媒体键相对直接；第一阶段也可以先用浏览器跑同一 UI。
- **Remote**：React + Vite 的响应式 Web App；同一套 Design System，但移动端信息架构应简化。PWA 视服务环境与 HTTPS 要求逐步支持。
- **Core API**：Node.js LTS + Fastify（或 Hono）；WebSocket 做事件推送，REST 做 CRUD。最终技术版本应在初始化仓库时锁定并记录。
- **持久化**：SQLite，迁移脚本，WAL，事务、备份/恢复。SQLite 驱动与 Electron/Windows 的兼容性必须经 CI 构建验证（如采用原生插件需正确重建）。
- **元数据**：`music-metadata` 等；当前版本支持 FLAC、DSF、DFF、WAV、WavPack 等解析，但个别文件元数据可能不足，需合理 fallback。  
  参考：https://www.npmjs.com/package/music-metadata
- **歌词**：本地 LRC / metadata + LRCLIB（遵守请求头、限流及版权/服务政策）。  
  官方：https://lrclib.net/docs
- **Windows 发布**：GitHub Actions `windows-latest`（或同级 Windows CI）构建 Electron Windows portable/zip；Mac 只负责开发和提交。不要假设 macOS 必定可直接完成所有 Windows 原生依赖打包。  
  参考：https://www.electron.build/docs/github-actions/

### Monorepo 建议结构

```text
hqplayer-studio/
├── apps/
│   ├── desktop/                   # Electron main/preload + desktop UI
│   └── remote/                    # Browser UI / PWA
├── packages/
│   ├── contracts/                 # API DTO / shared types / validation
│   ├── core/                      # REST + WebSocket + state orchestration
│   ├── hqplayer-adapter/          # Interface + Mock + real TCP/XML
│   ├── library/                   # scan, metadata, SQLite repository
│   ├── lyrics/                    # local search, LRCLIB, cache, sync
│   └── ui/                        # shared components and design tokens
├── scripts/
│   └── hqp-probe/                 # Windows read-only-first API diagnostic
├── fixtures/
│   ├── library/                   # license-safe sample files/metadata
│   └── hqplayer-protocol/         # sanitized recorded fixtures
├── docs/
│   ├── protocol-capabilities.md
│   ├── PROGRESS.md
│   ├── architecture.md
│   └── test-matrix.md
├── .github/workflows/
│   └── windows-build.yml
└── README.md
```

---

## 6. 领域模型和数据所有权

### 必须分清的三个概念

1. **Music Library（音乐库）**：用户真实拥有的歌曲、专辑及元数据，长期存在 SQLite。源文件保留在原路径，不复制、不改写、不重新编码。
2. **Saved Playlist（保存的播放列表）**：持久化、由用户编辑的歌曲集合；每个条目有稳定顺序，可允许重复歌曲。
3. **Now Playing Queue（当前播放队列）**：当前这一场播放会话的临时顺序；默认修改队列不自动修改 Saved Playlist。

### 数据库建议表

- `library_roots`：id, path, kind(local/UNC), enabled, last_scanned_at, last_error。
- `tracks`：id, source_path, file_identity, filename, title, artist, album_artist, album_id, disc_number, track_number, duration_ms, sample_rate, bit_depth, codec, channels, mtime, size, available, last_seen_at。
- `albums`：id, title, album_artist, year, release_id(可选), artwork_id, album_group_key；处理多碟/同名/不同母带情况。
- `artists` 和联接表；必要时处理多艺术家与各种标签。
- `artwork_cache`：cover hash/path/size，限制缓存大小。
- `playlists` + `playlist_items`：持久集合，排序字段与重复曲目实例 id。
- `queue_sessions` + `queue_items`：当前播放/应用级队列、来源和状态版本。
- `lyrics_cache`：track_id, source, type(plain/LRC/word), content, offset_ms, selected_by_user, last_checked_at。
- `app_settings`：用户偏好、主题、歌词偏移默认、遥控访问规则。
- `engine_observations`：可选，最近一次 HQPlayer 状态、时间戳和可信程度；**不把它视为持续有效的真实状态**。

**ID 规则**：同一个文件的标题或路径变化可能导致重建索引；不能把 `title + artist` 当作唯一主键。路径规范化、大小写、UNC、Unicode（日文/中文）、非法字符、软链接及内容指纹要有明确策略。扫描时 **offline != deleted**：磁盘/NAS 暂时离线不得自动清空收藏和播放列表。

### 状态所有权和同步策略

- **HQPlayer 是实际播放状态的最终权威**：play/pause/position/输出状态要以引擎回报为准，不只采用按钮点击后的乐观状态。
- **Studio 是自建库、Saved Playlists、UI 偏好的最终权威**。
- 队列的“计划状态”由 Studio 管理；如果 HQPlayer 实际队列无法可靠读取或外部控制器更改了队列，UI 必须显示 `Out of sync / External change`，提供刷新/接管选项，而非无声覆盖。
- 所有写命令串行化/排队；等待 ACK 或状态回读；超时要正确反馈且避免自动重试造成重复加曲/重播。
- 连接中断后重建权威状态；恢复时**不要自动发 Play、改音量、改 DSP 模式**。
- 进度条可本地平滑显示，但必须定期和 HQPlayer 状态校准；处理缓冲延迟、Seek、曲目切换及暂停。
- 专辑模式与 Playlist 模式建立明确的状态机；用户选择「播放整张专辑」时优先保证 Gapless，无法保证时诚实提示。

---

## 7. API Adapter 设计与验证计划（项目的技术关键）

### 不要把协议细节写死在 UI 中

定义接口（只是领域抽象，不暗示底层 XML 指令已经确认）：

```ts
export interface HQPlayerAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getCapabilities(): Promise<EngineCapabilities>;
  getStatus(): Promise<EngineStatus>;
  subscribeStatus(onChange: (state: EngineStatus) => void): () => void;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek?(positionMs: number): Promise<void>;
  setVolume?(db: number): Promise<void>;
  loadTrack?(track: PlayableTrack): Promise<void>;
  loadAlbum?(album: PlayableAlbum): Promise<void>;
  replaceQueue?(items: PlayableTrack[]): Promise<void>;
  getDspState?(): Promise<DspState>;
  updateDspSetting?(change: DspChange): Promise<void>;
}
```

**注意：** 上面 `?` 的接口代表可选能力；`next/previous/loadTrack` 等也应依据能力矩阵进行运行时禁用。实际类型可修改，但要保持 **Mock 和 Live 两套 Adapter 实现同一个契约**。

### 探测顺序（只读先行）

**Gate A — 连接（无副作用）**

- 从 SDK/官方工具确认控制端口、XML framing、连接行为、版本识别和超时。
- Windows 本机使用 `127.0.0.1:4321`；先读版本/状态。过去的 `Test-NetConnection` 成功只说明端口开放。
- 记录响应时间、错误响应、编码、会话断连场景；生成脱敏 JSON 报告。

**Gate B — 状态和枚举（无副作用）**

- 只读读取播放状态、歌曲/路径/进度、输入输出格式、DSP 选项/当前值、HQPlayer 内置库和服务端保存的播放列表（如果有）。
- SDK 中明确存在的命令才进入试验；导出 request/response fixtures，去掉真实本机路径、个人歌名和任何凭据。

**Gate C — 可回滚播放测试（用户同意后执行）**

- 先提示用户保存/记录当前播放队列与音量；只在可恢复、明确授权的情况下进行写操作。
- 用用户指定的一首**本地测试音轨**试验加载、播放、暂停、seek、下一首。
- 测试 Windows 路径包含中文、日文、空格及特殊符号时，URI 语法与编码是否正确。
- 测试 PCM/DSF、两首连播及整张专辑 Gapless；记录成功与不能保证的情形。
- 最后才验证服务端播放列表的 list/load/save 和 DSP 控制。**严禁默认把测试流写入用户正在听的播放列表。**

**Gate D — 集成条件**

`docs/protocol-capabilities.md` 至少有以下矩阵：

| Capability | 来源证据 | Desktop 6 实测 | 结果/限制 | 实现决策 |
|---|---|---|---|---|
| Connect / Get status | 官方 SDK | pending | — | — |
| Current title / elapsed | SDK | pending | — | — |
| Play / Pause / Stop | SDK | pending | — | — |
| Next / Previous / Seek | SDK | pending | — | — |
| Load local track / album | SDK | pending | — | — |
| Playlist read / load / save | SDK + 社区 | pending | — | — |
| Queue edit / shuffle / repeat | SDK | pending | — | — |
| 1x / Nx filters / modulator | SDK | pending | — | — |
| PCM/SDM mode / output rate | SDK | pending | — | — |
| Native device / ASIO / NAA setup | 需确认 | pending | — | 保留原生设置入口 |
| Convolution / Matrix / CUDA | 需确认 | pending | — | 不擅自改配置文件 |

**如果某个 P0 能力不存在：** 优先考虑官方 Library/Playlist 协议可行的替代方案；仍无法实现时，在 `docs/decision-log.md` 记录限制、实验、降级设计，绝不伪造“可用”。

---

## 8. 功能细则和 UX 验收标准

### 8.1 音乐库 / 文件系统

**UI：** 侧边栏含 `Home / Albums / Artists / Tracks / Folders / Playlists / Settings`。首次启动引导选择音乐目录，扫描进度与错误可见。不同浏览视图使用统一的搜索与筛选。

**行为：**

- 扫描多层目录，读取标签、音频格式、时长、封面；元数据不足时以文件名/目录结构兜底。
- 自动增量更新：文件监听 + 手动扫描/低频兜底扫描；不需要每次启动全库扫描。
- 音乐文件不因读取失败被移动或修改；出错时隔离该条并继续扫描。
- 同名专辑可区分不同发行版本与不同格式，支持多碟排序；优先使用标签而非字母排序。
- 支持中文/日文字符、日文括号、全角符号；搜索具备基本 normalize 与模糊匹配策略。
- NAS/USB 离线可保留条目但标记 unavailable；重新上线后可恢复。
- 缓存封面缩略图；首次扫描不得一次性解码大批超高分辨率封面导致卡顿。

**Done：** 首次导入后关闭程序、重启、断开网络，仍能浏览所有已索引的歌曲和专辑（不可用文件要有明显提示）。

### 8.2 播放列表、队列与专辑

- 创建/重命名/删除/复制播放列表；拖拽添加、移除和排序歌曲。
- 操作区分 `Play Now`、`Play Next`、`Add to Queue`、`Add to Playlist`，不能混淆。
- 播放整张专辑按 `disc_number, track_number` 排序；记录该操作是否使用 HQPlayer Album Mode。
- 支持循环、随机播放（具体 HQPlayer 支持情况需确认）；无法无缝切换时提示。
- 保持跨会话的 Saved Playlists、最近一次队列快照，默认不在启动后自动播放。
- 设备断开或 HQPlayer 被外部修改时，不误把数据库列表清空。

**Done：** 关闭 UI → 重新打开，原列表顺序不变；在网页选某个专辑后桌面端 Now Playing 可同步显示实际播放内容。

### 8.3 桌面 UI 和迷你播放器

**设计方向：** 现代、克制、深色优先，接近成熟音乐管理软件的产品密度；不是 HQPlayer 原始设置窗口的大按钮重绘。专辑封面、信息排版、间距、动效要专业，但可访问性和流畅度优先。

- 左侧常驻导航；中间内容；右侧可收起 Now Playing / Queue / Lyrics；底部播放条。
- 主界面快捷键：空格播放暂停，基础方向/搜索快捷键；避免在输入框中误触。
- 加载态/空状态/错误态设计完整；支持窄窗口布局。
- Mini Player：小窗口、封面+曲名、上一首/播放/下一首、展开、置顶；应用重启恢复窗口位置（在多显示器变化时重新校验边界）。
- 运行状态条显示 `HQPlayer connected / disconnected`、当前 PCM/DSD 输入输出（可用时）与 DSP 摘要。
- 不承诺替代 Windows 任务栏音频播放控制，需验收媒体键/系统媒体会话的实际效果。

**Done：** 在 Windows 上使用 Mini Player 不影响 HQPlayer 原生音频链；关闭 Mini Player 可回到完整客户端，数据不丢失。

### 8.4 歌词

匹配优先级：用户手动指定歌词 > 本地同名 `.lrc` / 文件内嵌歌词 > 本地缓存 > 在线搜索。多候选时允许用户手动选。

- 中文、日语、英文字符正确渲染，长行可换行。
- 有时间轴则同步滚动；纯文本展示为静态歌词；查无结果明确显示“未找到”。
- 支持显示/调整歌词偏移（正负毫秒/秒）；不要假设 API 进度等于实际声波抵达时间。
- 支持禁用在线歌词查询；为每条曲目存储最终关联与来源。
- LRCLIB 客户端需按官方要求带有效 `User-Agent`/客户端标识，尊重 429、`Retry-After` 和并发限制；不要在扫描全库时进行高并发抓取。
- 歌词内容的持久化、显示和分发需遵守服务条款和适用版权要求；不把受版权保护的完整歌词写进 Git 仓库。

**Done：** 指定一首带 LRC 的本地曲目，歌词随进度准确变化；歌词接口不可用时播放不受影响。

### 8.5 设置页

建议分类：`General / Library / Playback / DSP / Output / Lyrics / Remote / Diagnostics`。

- **可直接读写**：取决于实际 Control API capability。
- **可读不可写**：清晰展示，禁用更改按钮。
- **原生设置**：展示说明和 `Open in HQPlayer` 提示（如无法安全跳转，说明应手动打开原生设置）。
- 高风险更改（输出采样率、DSP 模式、设备配置）之前给出明确警告；播放中可能中断时要告知。
- 任何失效配置都能回显错误，并避免显示“操作成功”的假状态。

### 8.6 Web Remote

**移动信息架构：** `Now Playing / Browse / Playlists / Queue` 四个主导航；设置和连接状态进入次级菜单。适配 iPhone Safari 及 iPad 横屏。

- 浏览与搜索**同一份** Windows Studio 数据库，不创建另一个手机端音乐库。
- 用移动端发起播放，桌面端能及时同步。
- Web 页面不依赖 HQPlayer 原生控制 API 直接暴露给浏览器；它只访问 Studio Core 已认证的 API。
- 默认不含音频文件下载/流式播放功能；远程客户端只得到缩略图、元数据和操作能力。
- Windows 主机睡眠/离线时明确提示不可用，不伪装播放成功。

**Done：** Windows 开着 Studio 和 HQPlayer 时，用同网段手机浏览器访问经授权的网址，能选专辑/播放列表并控制播放；若网络互访受限，应显示可诊断原因而非强求绕开企业设备网络策略。

---

## 9. Core API 草案（示例，不等于已完成）

REST/WS 接口应以 schema（如 Zod）验证入参输出，保持版本化：

```text
GET    /api/v1/health
GET    /api/v1/engine/status
GET    /api/v1/engine/capabilities
POST   /api/v1/engine/transport          { action: play|pause|stop|next|previous }
POST   /api/v1/engine/seek               { positionMs }
GET    /api/v1/library/albums?q=&page=
GET    /api/v1/library/albums/:albumId
GET    /api/v1/library/artists
GET    /api/v1/library/tracks?q=&page=
GET    /api/v1/library/folders
POST   /api/v1/library/roots             { path }
POST   /api/v1/library/scan              { rootId }
GET    /api/v1/library/scan/:jobId
GET    /api/v1/playlists
POST   /api/v1/playlists
GET    /api/v1/playlists/:id
PATCH  /api/v1/playlists/:id
DELETE /api/v1/playlists/:id
POST   /api/v1/playlists/:id/items
PATCH  /api/v1/playlists/:id/items/order
GET    /api/v1/queue
POST   /api/v1/queue/replace
POST   /api/v1/queue/add
POST   /api/v1/playback/album/:albumId
POST   /api/v1/playback/playlist/:playlistId
GET    /api/v1/tracks/:id/lyrics
GET    /api/v1/artwork/:artworkId
GET    /api/v1/remote/pairing-status
WS     /api/v1/events                  engine.status, queue.changed, library.scan, etc.
```

注意：**上表是我们自建 Studio API 的设计草案，不是 HQPlayer 原生协议指令。**

---

## 10. 开发阶段、里程碑、退出条件

### Phase 0 — 能运行的仓库 + 风险隔离

**产出：** pnpm monorepo、TypeScript 严格类型、MockHQPlayerAdapter、固定演示专辑与曲目、桌面壳、远程 Web 基础页、自动化测试、Windows CI 构建产物、Windows 只读探针。

**退出条件：** Mac 上 `pnpm install`、`pnpm dev`、`pnpm test`、`pnpm build` 正常；Mock 中能模拟播放、暂停、换歌与断线；CI 能产生 Windows 可下载/拷贝的应用/探测工具。

### Phase 1 — HQPlayer Desktop 6 真机 API Spike

**产出：** 官方 SDK 来源记录、原始协议封装、真实版本与状态响应、能力矩阵、可脱敏的 probe report、端到端连接测试。控制写入在单独明确的用户确认后再做。

**退出条件：** Windows 本机的 Studio 能连接真实 HQPlayer 6；至少能稳定读取状态；基础传输控制和加载曲目的结果有真实记录。若某能力缺失，记录降级方案。

### Phase 2 — 持久音乐库 + 播放列表

**产出：** Windows 文件夹扫描/重新扫描、SQLite、专辑/文件夹/歌手视图、搜索、播放列表、即时队列，以及将文件/专辑映射到 HQPlayer 的能力。

**退出条件：** 程序重启数据不丢；扫描错误可恢复；日文/中文路径可处理；实际选专辑并播放（或明确说明已观察到的协议限制）。

### Phase 3 — 同步的 Web Remote

**产出：** 经认证的 HTTP/WS 服务、配对流程、移动端浏览和遥控、桌面/手机实时状态同步、基本 PWA 配置。

**退出条件：** 同一个 Windows 主机上的桌面端与家庭局域网内已授权手机可以相互看到一致状态，断线与重新连接都可恢复。

### Phase 4 — 迷你播放器、歌词、设置 UX

**产出：** 原生小窗口、媒体键/托盘（可用时）、LRC+LRCLIB、可读写设置分层、主题优化、交互 polish。

**退出条件：** 用户的五项桌面功能与网页遥控需求均达到实际可用；不可控制的原生设置有明确说明，而非假 UI。

### Phase 5 — 稳定性与发布

**产出：** 大库性能、长期 DSD512 播放压力验证、断线恢复、日志、崩溃回报、数据库备份、版本打包、README/用户指南、第三方声明。

**退出条件：** 连续聆听与增量扫描不造成可归因的播放故障；回滚旧版本及备份/恢复可行；正式包不要求 Windows 安装完整开发工具链。

> 阶段按**能力门槛**而非日历时间推进。完成一个有可运行交付物的阶段后再推进下一个，不做只为好看的无业务功能原型。

---

## 11. 自动化测试 / 实测矩阵

**单元测试（Mac Mock）：**

- Playlist CRUD、排序、重复歌曲、撤销、重启持久性。
- Track/Album 唯一性、metadata fallback、中文/日文 Unicode、文件离线恢复。
- 队列并发写入和 ACK 超时，回连后的状态合并。
- Album Mode vs Playlist Mode 的领域规则。
- 歌词 LRC 解析、时间偏移和多语言字符。

**集成测试（Mock Socket + SQLite 临时库）：**

- 模拟 TCP 消息半包/粘包、异常 XML、超时、服务重启、未知 API 字段。
- 模拟扫描 1000+ 首曲目、异步封面缓存、增量新增/删除/移动。
- 模拟 Desktop 和 Web 同时切歌，确保服务端最终状态一致。

**Windows 真实验收（用户协助执行）：**

- `127.0.0.1:4321` 真机协议读写、真实 HQPlayer Desktop 6 build 号。
- WAV/FLAC/DSF/DFF 的**测试音轨**；同目录多碟和日韩路径。
- PCM → DSD512 常用流程，观察 CPU/I/O 负担和缓冲/歌词时间基准。
- Album/Playlist 切换、Pause/Resume、连续播放、跳曲、HQPlayer 原生 UI 手动干预。
- Win10/Win11 版本、显示缩放、多屏 Mini Player、系统媒体快捷键（按实际环境）。
- 同局域网 iPhone Safari/iPad 浏览器访问 Windows Studio Web Remote。

**关键保护：** 所有自动化 CI 测试都不得依赖真正的 HQPlayer 许可证或接触真实音频硬件；真实集成测试明确区分只读和有副作用命令。

---

## 12. 性能、隐私和安全底线

1. **音质不变**：Studio 不插入音频数据处理链；不添加系统 mixer；不修改 HQPlayer 采样参数，除非用户明确通过已验证设置功能提出更改。
2. **HQPlayer API** 默认仅连接 `127.0.0.1:4321`。它通常不是为公网暴露设计；浏览器不得直接发送原始 HQPlayer XML。
3. **Web Remote** 默认关闭 LAN 监听；用户显式启用后绑定本地可信网卡，实行一次性配对码/短期令牌、鉴权、CSRF/Origin 检查、WebSocket 认证、合理速率限制。避免端口映射到公网。
4. **文件访问**：扫描根路径需本机用户主动选择；Web 客户端不得传任意绝对路径获取/删除 Windows 文件；阻止 `../` 路径穿越。封面从受控缓存提供。
5. **Electron** 使用 `contextIsolation: true`、`nodeIntegration: false`、sandbox、限制 preload 暴露能力、CSP；遵守官方安全指南：  
   https://www.electronjs.org/docs/latest/tutorial/security/
6. **Windows 性能**：限制音乐扫描并发；大库解析不要占满资源；检测实际播放和 DSD512 压力时允许暂停/降速扫描。
7. **日志脱敏**：不上传私有音乐目录树、许可证、音频文件、歌词内容或公司设备信息；用户导出调试日志时先脱敏。
8. **网络与公司设备**：不得绕过强制 VPN、终端安全软件或公司策略；Mac→Windows 连接不通不构成项目阻塞。
9. **版权**：不将受版权保护的音乐或完整歌词作为项目测试资源提交仓库；公开发布需核查使用的 SDK 和第三方包许可证、产品命名与商标声明。
10. **更新策略**：更新 Studio 不得自动升级 HQPlayer、更换 Windows 设备绑定授权或覆盖用户已有的 HQPlayer 设置。

---

## 13. Agent 工作方式 / 行为规范

- 首选**可运行的垂直切片**：真实的库列表→选择→队列→Mock/Live Adapter→状态回显，而不是分别建一堆未连起来的页面。
- 决策分层：产品需求参考本文件；HQPlayer 协议以 Signalyst SDK + Desktop 6 实测为准；开源项目只做参考，不能当官方标准。
- 每个关键技术决定写一段 `docs/decision-log.md`：问题、选项、选择、理由、风险、后悔成本。
- 优先完成 P0，主动制止需求膨胀；对 P1/P2 标注待办。
- 不要在全局状态塞满未类型化对象；跨进程数据使用 contracts + runtime validation。
- 每个阶段附实际运行命令、截图（如方便）、日志和测试结果。主动修复 TS/构建错误，不要宣布“理论上可以运行”就视为完成。
- 如果无法直接访问 Windows：不要将网络问题无限排查；交付 portable Windows 探针、明确用户只需运行哪些程序并回传哪个 JSON 文件。
- 用户重视实际听音系统稳定性：所有潜在影响播放的试验默认在用户手动确认后启动；不得在后台自动改 DSP 或音量。
- UI 文案可以优先中文，但架构预留 i18n 机制（中文/英文）；不要把所有文字硬编码在组件内。

### 每次交付时的固定报告格式

```text
Implemented:
- [可运行的内容]

Verified:
- [执行的具体测试和结果]

Known limitations:
- [无法验证 / HQPlayer 限制 / 部署环境限制]

Next:
- [下一个小的可运行目标]

Windows action needed (only if needed):
- [精确的最少步骤，预计产生的日志文件/输出]
```

---

## 14. 建议的第一周 / 第一轮任务清单（不依赖用户立即反馈）

- [ ] 初始化 monorepo，锁定兼容的 Node LTS / TypeScript / Electron / pnpm 版本。
- [ ] 实现 `contracts`，包含 Album / Track / Playlist / Queue / EngineStatus / EngineCapabilities / DspState。
- [ ] 实现 MockHQPlayerAdapter：播放、暂停、下一首、seek、网络断连、切换 PCM/DSD 伪状态。
- [ ] 实现 SQLite schema + migration + seed data + 数据仓库的单元测试。
- [ ] 做桌面首页和 Albums / Playlists / Now Playing 基础 UI（不使用真实音频文件做 mock assets）。
- [ ] 做 Web Remote 的 Now Playing / Browse / Playlists 页面，共用数据契约。
- [ ] 建立 Studio Core REST/WS；让两个 UI 可互相反映 Mock 的变化。
- [ ] 创建 Windows CI pipeline，生成可下载的 portable 包；构建时确保 Electron/SQLite 原生依赖可用。
- [ ] 获取/检查官方 HQPlayer Control SDK，整理准确的指令与封包形式。
- [ ] 准备只读 Windows Probe：一键连接 `127.0.0.1:4321`、读取状态、导出 `hqp-probe-report.json`；默认不包含敏感路径。
- [ ] 写 `docs/protocol-capabilities.md` 初版，把尚未实测全部标记 pending。
- [ ] 提供 `README.md` 的 Mac 开发命令与 Windows 一键运行说明。

**第一个真正的验收 Demo：** Mac 上打开现代桌面 UI，使用 Mock 数据浏览几张专辑、保存一个播放列表、播放某首歌，另一浏览器打开 Web Remote 能同步看到封面和播放状态。Windows 端则另有一个只读 Probe 可供下一步真机核验。

---

## 15. 用户后续需要提供的信息（非启动阻碍）

请 Agent **不要在开始前逐一询问**，而是在相应阶段用最少问题获取：

1. HQPlayer Desktop 6 **准确的小版本/build**，以及官方 CLI/SDK 真机探测结果（Phase 1）。
2. 音乐文件根目录和存储类型：Windows 本地盘/USB/NAS（Phase 2）。
3. 用户对颜色、字体、信息密度及是否需要中文/英文切换的偏好（UI 优化阶段）。
4. Windows 主机是否允许本机启动 Studio 后端常驻服务；iPhone/iPad 能否在家中访问 Windows 的 Web 端口（Phase 3）。
5. 是否允许测试有副作用的 API（修改队列/切换 DSP/音量等），以及可用于测试的单独小专辑目录（Phase 1）。

不要因为这些细节尚未给出就停留在规划；Mock + 数据结构 + UI + 测试 + Windows Probe 都可先实现。

---

## 16. 主要参考资料（独立可访问，不依赖本次对话）

**官方优先**

1. Signalyst — HQPlayer Quickstart（Server/Client、内置库、Album/Playlist 模式）：https://signalyst.com/quickstart-guide/
2. Signalyst — HQPlayer SDK / Downloads（Control API 参考源码）：https://signalyst.com/downloads/
3. Signalyst — HQPlayer 6 Desktop 支持格式与功能：https://signalyst.com/hqplayer-desktop/
4. Signalyst — 文档入口、安装目录说明：https://www.signalyst.com/quickstart.html

**实现和设计参考（第三方，版本差异需自行核验）**

5. HQPDcontrol（音乐库、队列、DSP、歌词设计参考）：https://hqpdcontrol.alpr.cz/
6. HQPWV（旧版 Web Remote 开源参考）：https://github.com/zeropointnine/hqpwv
7. 2026-09 社区讨论 HQPlayer 5/6 Playlist 命令：https://audiophilestyle.com/forums/topic/72255-playlist-name/
8. LRCLIB API 及限流要求：https://lrclib.net/docs
9. music-metadata 格式/元数据支持：https://www.npmjs.com/package/music-metadata
10. Electron 安全建议：https://www.electronjs.org/docs/latest/tutorial/security/
11. electron-builder Windows CI：https://www.electron.build/docs/github-actions/

---

## 17. 完成定义（Project Definition of Done）

一个能被用户**实际替代原生 HQPlayer 日常音乐操作界面**的 Windows 客户端，至少满足：

- 不需要每次重新 Import：首次选择音乐目录后，后续直接按专辑/歌手/文件夹找到音乐。
- 播放列表能保存、编辑和重启恢复；当场播放队列和保存列表是分离的。
- 能可靠向原版 HQPlayer 6 发出播放命令，并回读真实状态；遇到协议限制时明显提示。
- 有现代桌面 UI、可使用的迷你播放器、可选的同步歌词。
- 有同一音乐库驱动的手机/iPad Web Remote，能切歌、切专辑、切播放列表。
- 原 HQPlayer 已授权 Windows 设备、DSP/CUDA/DSD512 处理链和 DAC 输出都不改变。
- Mac 负责开发；Windows 负责运行、简单验证，无需搭建 Windows 开发环境。
- CI 可构建交付，测试和日志能追溯问题；没有未经验证的“支持”宣称。

> **最终北极星：HQPlayer 是不可见的高品质音频引擎，HQPlayer Studio 是用户日常真正想打开的音乐播放器。**
