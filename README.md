# HQP Studio (HQPlayer Studio)

[中文](#中文) · [English](#english)

---

## 中文

### 简介

HQP Studio 是一个面向 **HQPlayer Desktop 6** 的第三方音乐库、播放列表管理器和手机遥控器。
HQPlayer 继续负责解码、DSP、升频和 DAC 输出；Studio 只负责**找音乐、排队、遥控**，不插入音频链路。
发布于rikus.rocks

### 主要功能

- **音乐库**：按专辑 / 歌手 / 歌曲 / 文件夹浏览、搜索；扫描只读，不改动你的文件。
- **播放列表与队列**：编辑播放列表、即时队列，与 HQPlayer 保持同步；外部改动会提示，不会静默覆盖。
- **遥控 HQPlayer**：播放控制、音量、DSP 设置（需在设置中开启，只开放已验证的命令）。
- **手机 / iPad 遥控**：局域网网页遥控，配对码配对（默认关闭）。
- **迷你播放器、媒体键、托盘图标**（Windows）。
- **同步歌词与封面**：优先使用本地文件；在线来源默认关闭，逐个开启。
- **Studio EQ**：生成脉冲文件，交给 HQPlayer 自己的卷积使用。
- **Apple Music（实验功能）**：经虚拟声卡进入 HQPlayer 的实时输入并升频。
- **设置向导**：第一次打开时引导配置 HQPlayer、音乐文件夹和控制权限。
- **稳定性**：自动备份数据库、一键恢复与版本回退、本地日志与崩溃报告（不上传）。
- **界面**：多种颜色主题、中文 / 英文。

### 快速开始

- 使用者：从 **Releases** 下载 Windows 安装包，参见 [安装与上手](docs/getting-started.md) 和 [用户指南](docs/user-guide.md)。
- 开发者（macOS，Node ≥ 24.11，pnpm 12）：

```bash
pnpm install
```

```bash
pnpm dev
```

### 项目结构

```text
apps/desktop               Electron 桌面端（main / preload / React 界面）
apps/remote                手机网页遥控
packages/core              REST + WebSocket 服务、引擎监督、队列编排、扫描任务
packages/hqplayer-adapter  HQPlayer 适配器：Mock 引擎 + 基于官方 SDK 的 TCP/XML 协议层
packages/library           SQLite 数据库、迁移、扫描器、封面缓存、演示数据
packages/contracts         共享数据类型与校验
packages/api-client        API 客户端 + 自动重连 WebSocket
packages/ui                共享组件、主题、多语言
packages/lyrics            歌词解析与在线歌词来源
scripts/hqp-probe          只读探测工具
docs/                      用户指南、架构、决策记录、进度、测试矩阵
```

### 免责声明

- 本项目是**非官方**的第三方软件，与 **Signalyst** 没有任何隶属、合作或认可关系。HQPlayer 是 Signalyst 的产品和商标，需要你自行购买并取得合法授权。
- 本软件按“原样”提供，不附带任何形式的担保。使用本软件造成的任何损失（包括数据丢失或设备问题），作者概不负责。
- Studio 不修改 HQPlayer 的配置或许可证，也不会去除任何音乐的版权保护（DRM）。Apple Music 功能只通过系统音频路由工作，请遵守相关服务条款。
- 在线歌词和封面来自第三方服务，版权归原权利人所有，仅供个人使用。
- 程序未签名，首次运行时 Windows SmartScreen 可能会提示。

许可证：MIT —— 见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

### Introduction

HQP Studio is an unofficial, third-party music library, playlist manager and phone remote for **HQPlayer Desktop 6**.
HQPlayer stays the audio engine — decoding, DSP, upsampling and DAC output. Studio only **finds music, builds the queue and sends remote commands**. It never sits in the audio path.

### Features

- **Music library**: browse and search by album, artist, track or folder. Scanning is read-only and never changes your files.
- **Playlists and queue**: edit playlists and a live queue that stays in sync with HQPlayer. Changes made elsewhere are flagged, never silently overwritten.
- **HQPlayer control**: transport, volume and DSP settings. You must turn control on in Settings, and only commands verified on a real engine are enabled.
- **Phone / iPad remote**: a web remote on your home network, paired with a one-time code. Off by default.
- **Mini Player, media keys and tray icon** (Windows).
- **Synced lyrics and cover art**: local files first. Online sources are off by default and turned on one at a time.
- **Studio EQ**: builds an impulse file for HQPlayer's own convolution.
- **Apple Music (experimental)**: played through a virtual sound card into HQPlayer's live input for upsampling.
- **Setup wizard**: on first launch it walks you through HQPlayer, music folders and control permissions.
- **Reliability**: automatic database backups, one-click restore and version rollback, local logs and crash reports (never uploaded).
- **Interface**: several colour themes; Chinese and English.

### Getting started

- Users: download the Windows installer from **Releases**, then see [Getting started](docs/getting-started.md) and the [user guide](docs/user-guide.md#english).
- Developers (macOS, Node ≥ 24.11, pnpm 12):

```bash
pnpm install
```

```bash
pnpm dev
```

### Project structure

```text
apps/desktop               Electron desktop app (main / preload / React UI)
apps/remote                Phone web remote
packages/core              REST + WebSocket server, engine supervisor, queue orchestration, scan jobs
packages/hqplayer-adapter  HQPlayer adapter: mock engine + TCP/XML protocol layer derived from the official SDK
packages/library           SQLite database, migrations, scanner, artwork cache, demo data
packages/contracts         Shared data types and validation
packages/api-client        API client + auto-reconnecting WebSocket
packages/ui                Shared components, themes, i18n
packages/lyrics            Lyric parsing and online lyric sources
scripts/hqp-probe          Read-only probe tool
docs/                      User guide, architecture, decision log, progress, test matrix
```

### Disclaimer

- This is **unofficial** third-party software. It is not affiliated with, endorsed by, or supported by **Signalyst**. HQPlayer is a product and trademark of Signalyst; you need your own licensed copy.
- The software is provided "as is", without warranty of any kind. The authors are not liable for any loss or damage arising from its use, including data loss or equipment issues.
- Studio does not change HQPlayer's configuration or licence, and never removes copy protection (DRM) from any music. The Apple Music feature works only through system audio routing; follow the terms of the services you use.
- Online lyrics and cover art come from third-party services and belong to their respective rights holders; for personal use only.
- Builds are unsigned, so Windows SmartScreen may warn on first run.

License: MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
