# HQPlayer Control API — 协议事实与能力矩阵

> 状态：**Phase 1 — 只读路径已在用户的 HQPlayer Desktop 6（engine 6.1.0，Windows）停止与播放状态下验证；所有写命令仍为 `untested` 且禁用。** 最后更新：2026-11-10。
>
> 规则：没有真机证据的能力一律不得在应用中标为“已支持”。本文件只能根据 `hqp-probe` 报告或经用户同意的 Gate C 测试结果更新。

## 1. 证据等级

| 等级          | 含义                                                              |
| ------------- | ----------------------------------------------------------------- |
| `confirmed`   | 已在用户的 HQPlayer Desktop 6 上验证（附报告/版本号）             |
| `observed`    | 在真机上观察到可用，但尚未系统验证                                |
| `untested`    | 官方 SDK 源码中存在，尚未在 Desktop 6 上执行                      |
| `unsupported` | 已知不存在 / 不可用                                               |
| `simulated`   | 仅 MockHQPlayerAdapter 提供（应用内用于开发，**不代表**真机支持） |

## 2. 来源

- **官方 SDK**：Signalyst “HQPlayer SDK — Source code for the control API implementation and command line utility (re engine version 6.0.1)”，文件 `hqp-control-601-src.zip`（22,781 bytes），2026-11-10 从 <https://signalyst.com/downloads/> 获取。
  - 文件：`ControlInterface.hpp/.cpp`、`ControlApplication.hpp/.cpp`、`Main.cpp`、`control.pro`（`VERSION = 4.0.0`，`TARGET = hqp6-control`）。
  - 许可证：**MIT**（© 2011-2026 Jussi Laako）。SDK 源码只在本地阅读，**未提交到本仓库**；本仓库中的协议实现为独立的 TypeScript 代码，命令清单与报文格式源自该 SDK（见 `THIRD_PARTY_NOTICES.md`）。
- **用户环境的既有观察**：Windows 上曾看到 `0.0.0.0:4321 LISTENING`，`Test-NetConnection 127.0.0.1 -Port 4321` 成功 —— 只证明 TCP 端口开放。

## 3. 由 SDK 源码确认的协议事实（`untested` on Desktop 6）

| 主题          | SDK 中的做法                                                                                                                                                                                                                        | 证据位置                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 传输          | TCP，默认端口 **4321**；客户端开启 TCP keep-alive（Linux 下 KEEPCNT=3、KEEPINTVL=10）                                                                                                                                               | `connectToHost`, `onConnected`           |
| 请求格式      | 每条命令是一个完整 XML 文档：`<?xml version="1.0" encoding="UTF-8"?><Cmd attr="…"/>` + `\n`（`QXmlStreamWriter::writeEndDocument` 追加换行）                                                                                        | 各命令方法                               |
| 响应分帧      | 客户端按 `\n` 切行，把行喂给增量 XML 解析器，直到 `EndDocument`；即**一个响应文档可跨多行**（列表类响应）                                                                                                                           | `onReadyRead`                            |
| 请求/响应匹配 | 无请求 ID；响应根元素名 = 命令名（如 `<GetInfo …/>`、`<Play result="OK"/>`）                                                                                                                                                        | `onReadyRead` 分支                       |
| 错误          | `result="Error"`，错误文本在元素文本中；成功为 `result="OK"`                                                                                                                                                                        | `onReadyRead` else 分支                  |
| 推送          | `<Status subscribe="1"/>` 后服务端推送 `Status` 文档（含 `<metadata …/>` 子元素）                                                                                                                                                   | `status(bool)`, `statusResponse`         |
| 保活          | 客户端可发送单个空格 `" "`                                                                                                                                                                                                          | `sendKeepAlive`                          |
| 二进制        | `LibraryPicture` 响应头含 `size`，随后跟随原始图片字节（不是 XML）                                                                                                                                                                  | `onReadyRead` 开头                       |
| 二次转义      | 部分文本属性（artist/album/song…）在服务端被再次转义，SDK 用 `fromEscaped()` 还原                                                                                                                                                   | `fromEscaped`                            |
| 认证          | 可选 `SessionAuthentication`：ECDH(secp256r1) + 客户端私钥签名 + 服务端 Ed25519 公钥校验，会话密钥用于 ChaCha20-Poly1305 加密 `secure_uri` 等字段。需要 Signalyst 发放的客户端密钥。**CLI 工具本身不做认证** → 推断基础命令无需认证 | `authenticate`, `completeAuthentication` |
| 需会话的命令  | `ConfigurationLoad`、`LibraryLoad`（仅在有会话密钥时发送）                                                                                                                                                                          | 对应方法                                 |
| 本地路径      | CLI 对 `file:`/`http(s):`/`audio:` 原样传 URI，否则把本地路径规范化为**原生分隔符的绝对路径**传给 `PlaylistAdd uri=`                                                                                                                | `ControlApplication::onConnected`        |
| 发现          | UDP 组播 `239.192.0.199` / `ff08::c7`，端口 4321，报文 `<discover>hqplayer</discover>`                                                                                                                                              | `discoverHosts`                          |
| 电平表        | 独立 TCP 连接，端口 = 控制端口 + 1（二进制帧）                                                                                                                                                                                      | `clMeterInterface::setServer`            |
| 状态枚举      | `state`: 0 stopped, 1 paused, 2 playing, 3 stop requested；`repeat`: 0 none, 1 single, 2 all                                                                                                                                        | `enum State/Repeat`                      |

### 需要真机确认的假设（2026-11-10 探测后的状态）

| #   | 问题                                             | 状态                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Status` 的 `position` / `length` 单位           | **已确认：秒（double）**——播放中 `length=320.64`（5:20 曲目）。`output_delay` 为**微秒**（4413312 = 4.41 s，DSD512 缓冲）；HQPlayer 自己的 `min:sec` = `position − output_delay`（12.54 − 4.41 → 0:08）。Studio 显示该“可听位置”              |
| 2   | 索引是 0 基还是 1 基                             | `PlaylistItem.index` **1 基**（已确认）；`Status track`：停止时 0、播放中 31 / `tracks_total` 52 → 与 1 基一致。Studio 运行时按文件 URI 定位当前曲目并核对基数（诊断页显示“已核对”）；`SelectTrack`/`PlaylistRemove` 推测 1 基，**待 Gate C** |
| 3   | 推送频率 / 取消订阅                              | **已确认**：播放中约每秒 1 次（中位 1001 ms）；停止时仅变化时推送                                                                                                                                                                             |
| 4   | `Pause` 语义                                     | 待 Gate C                                                                                                                                                                                                                                     |
| 5   | 本地路径形式                                     | **已确认**：`uri` = **`file://` + 原始 Windows 路径**（如 `file://D:\…`；反斜杠、空格、中文/日文均未编码，无 `%XX`）。`PlaylistAdd` 应传什么形式待 Gate C（先试官方 CLI 的原生路径）                                                          |
| 6   | 未认证时 `<metadata>` 是 `uri` 还是 `secure_uri` | **已确认**：播放中给出明文 `uri`（以及 song/artist/album/samplerate/bits/sdm），可直接匹配音乐库；停止时无 `<metadata>`                                                                                                                       |
| 7   | Album / Playlist 模式                            | 只能读取：本次 `PlaylistGet album="0"`（播放列表模式）；SDK 无切换命令 → `mode.album` = `unsupported`                                                                                                                                         |
| 8   | 多客户端并发                                     | 待观察                                                                                                                                                                                                                                        |
| 9   | 同连接按序应答                                   | 19 条串行命令全部按序应答（0–2 ms）；Studio 仍强制单飞                                                                                                                                                                                        |

## 4. 命令清单（SDK 6.0.1）与副作用分级

完整清单见 `packages/hqplayer-adapter/src/protocol/commands.ts`。分级决定安全策略：

| 分级                            | 命令                                                                                                                                                                                                                                                                                                                                             | 策略                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `none`（只读）                  | GetInfo, State, Status, VolumeRange, GetModes, GetFilters, GetShapers, GetRates, GetJunkFilters, GetDisplay, GetTransport, GetInputs, MatrixGetProfile, MatrixListProfiles, ConfigurationGet, ConfigurationList, LibraryGetHash, LibraryGet, LibraryPicture, LibraryFavoriteGet, PlaylistGet, PlaylistGetList, PlaylistGetSingle, PlaylistGetAll | Gate A/B 可直接使用（`LibraryGet`/`LibraryPicture`/`PlaylistGetAll` 因体量或二进制不在默认探测内） |
| `sensitive`（只读但含个人信息） | GetLicense                                                                                                                                                                                                                                                                                                                                       | **永不探测**                                                                                       |
| `session`                       | SessionAuthentication, Status subscribe=1                                                                                                                                                                                                                                                                                                        | 仅影响本连接                                                                                       |
| `playback`                      | Play, Pause, Stop, Next, Previous, Backward, Forward, Seek, SelectTrack, PlayNextURI, LoadRemovable, Volume*, SetRepeat, SetRandom                                                                                                                                                                                                               | Gate C：须用户明确同意                                                                             |
| `queue`                         | PlaylistAdd, PlaylistRemove, PlaylistMoveUp/Down, PlaylistClear, PlaylistLoad                                                                                                                                                                                                                                                                    | Gate C                                                                                             |
| `persist`                       | PlaylistSave, PlaylistDelete, PlaylistUpload, LibraryFavoriteSet*, LibraryLoad                                                                                                                                                                                                                                                                   | Gate C 之后，单独确认                                                                              |
| `settings`                      | SetMode, SetFilter, SetShaping, SetRate, SetJunkFilter, SetInvert, SetAdaptiveVolume, SetConvolution, SetDisplay, SetTransport*, MatrixSetProfile, ConfigurationLoad, Reset                                                                                                                                                                      | 永不自动发送；`Reset` 永不发送                                                                     |

`HqpConnection` 默认是**只读连接**：发送任何非 `none` 命令（`Status` 订阅除外）都会在本地抛错，报文根本不会离开进程；不在 SDK 清单中的命令名同样被拒绝。

## 5. 能力矩阵（Gate D）

“Desktop 6 实测”列来自 `hqp-probe` v0.1.0 报告（2026-11-10，engine 6.1.0，19/19 只读命令成功）。

| Capability                       | 来源证据                     | Desktop 6 实测                        | 结果/限制                                                                                                                        | 实现决策                                                       |
| -------------------------------- | ---------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Connect / Get status             | SDK + 探测                   | **confirmed**                         | TCP 2 ms；无需认证；`GetInfo` = Signalyst HQPlayer Desktop / version 6 / engine 6.1.0 / Windows                                  | Live adapter 只读连接                                          |
| Current title / elapsed          | SDK `Status` + `PlaylistGet` | **confirmed**                         | 播放中 `<metadata>` 含明文 uri；停止时无 metadata 且 `tracks_total` = 0（播放中 = 52）；位置单位为秒，另有 4.41 s `output_delay` | 显示可听位置；按 URI 定位当前曲目；停止时从 `PlaylistGet` 补全 |
| Play / Pause / Stop              | SDK                          | pending (Gate C)                      | —                                                                                                                                | 禁用                                                           |
| Next / Previous / Seek           | SDK                          | pending (Gate C)                      | Seek 单位推测为秒                                                                                                                | 禁用                                                           |
| Load local track / album         | SDK                          | pending (Gate C)                      | 观察到引擎内部存储为 `file:` + 原始路径                                                                                          | 禁用；Gate C 先试原生路径（与官方 CLI 一致）                   |
| Playlist read / load / save      | SDK + 探测                   | **read confirmed**；load/save pending | `PlaylistGet` 52 项、1 基索引；`PlaylistGetList` 为空                                                                            | 只读展示（诊断页）；写入待 Gate C                              |
| Queue edit / shuffle / repeat    | SDK                          | pending (Gate C)                      | —                                                                                                                                | 禁用                                                           |
| 1x / Nx filters / modulator      | SDK + 探测                   | **read confirmed**                    | 77 个 filter（含 `arg`、描述）、36 个 shaper；`State` 中 filter/shaper/mode/rate 为**列表索引**                                  | 只读展示；写入永不自动                                         |
| PCM/SDM mode / output rate       | SDK + 探测                   | **read confirmed**                    | 当前：`SDM (DSD)`、`sinc-Mx`、`ASDM7EC-super 512+fs`、24.576 MHz（DSD512 48k 族）；`GetRates` 21 项                              | 只读展示                                                       |
| Volume                           | SDK + 探测                   | **read confirmed**                    | −6.02 dB，`VolumeRange` −12…0，`enabled="0"`                                                                                     | 只读；设置待 Gate C（可能在 HQPlayer 中被禁用）                |
| Native device / ASIO / NAA setup | SDK 无命令                   | n/a                                   | `GetTransport value=240`（播放列表传输）                                                                                         | 显示 “Requires native HQPlayer settings”                       |
| Convolution / Matrix / CUDA      | SDK + 探测                   | read observed                         | Matrix profile 为空；`SetConvolution` 未测；CUDA 无命令                                                                          | 不改配置文件                                                   |
| Album / Playlist mode            | SDK + 探测                   | `unsupported`（切换）                 | 只读标志                                                                                                                         | “播放整张专辑”按碟/曲序装载并提示无法保证 Gapless              |
| Status push                      | SDK + 探测                   | **confirmed**                         | 播放中约 1 次/秒；停止时变化才推送                                                                                               | 订阅；序号变化时重读播放列表；界面在推送之间平滑插值           |

运行时矩阵：`packages/hqplayer-adapter/src/live/capability-matrix.ts`（`DESKTOP6_EVIDENCE`）。

## 6. 探测计划与工具

- **Gate A/B（无副作用）**：`hqp-probe.exe`（CI 构建，单文件，无需安装 Node）。见 `scripts/hqp-probe/README-WINDOWS.txt`。
  - TCP 连接 → 被动监听 750 ms（看是否有欢迎报文）→ 依次发送 19 条只读命令 → `Status subscribe="1"` 观察 3 秒推送 → 断开。
  - 报告默认脱敏：曲名、路径、播放列表名、实例名、配置名等替换为结构描述（如 `[redacted path scheme=native-drive depth=4 ext=flac nonAscii=yes pct=no …]`），保留回答上面“假设 5”所需的信息。
- **Gate C（有副作用）**：未实现开关。需要用户明确同意 + 指定测试专辑后，再以 `LiveHQPlayerAdapter({ policy: { allowUntestedWrites: true } })` 的方式逐项验证。
- **fixtures**：用户的原始报告**不提交**到公开仓库。测试中的响应（`LiveHQPlayerAdapter.test.ts`）按真机报告的属性结构合成，媒体字段为虚构值。

## 7. 真机记录

| 日期       | 工具                                           | 引擎                                                               | 结果                                                                                                                                                                                                                                                                            |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-10 | hqp-probe v0.1.0（Gate A/B，只读）             | Signalyst HQPlayer Desktop 6，engine 6.1.0，Windows 10.0.26200 x64 | TCP 2 ms；19/19 只读命令成功（0–2 ms）；无欢迎报文；停止状态；输出 SDM (DSD) 24.576 MHz；播放列表 52 项（1 基）；`Status subscribe="1"` 有应答（3 秒 1 次推送）                                                                                                                 |
| 2026-11-10 | hqp-probe v0.1.1（Gate A/B，只读，**播放中**） | 同上                                                               | 19/19 成功；`position` 12.544 / `length` 320.64（秒）；`output_delay` 4413312 µs；`track` 31 / `tracks_total` 52；`<metadata>` 明文 uri（`file://` + 原始路径）；推送约 1 次/秒；`PlaylistGet album="0"`；`State mode=2` ↔ `GetModes` 索引 2 “SDM (DSD)”（确认 State 中为索引） |

### 由此修正的实现（2026-11-10）

- `Status tracks_total` 不再当作播放列表长度（真机为 0，而播放列表有 52 首）。否则 Studio 会误报“HQPlayer 播放列表为空/不一致”。
- 引擎索引按 1 基转换（Studio 内部 0 基）。
- 停止时从 `PlaylistGet` 补全当前曲目信息；`track_serial`/`transport_serial` 变化时只读重读播放列表。
- 解析 `file://` + 原始 Windows 路径（不做 URI 解码，`100% Pure.flac` 等文件名不被破坏），用于把引擎曲目匹配回音乐库。
- 进度显示为可听位置（`position − output_delay`），与 HQPlayer 自身显示一致；`outputDelayMs` 单独提供给后续歌词同步。
- 当前曲目优先按文件 URI 在播放列表中定位（不依赖编号），并在运行时核对 `Status track` 的编号基数。
- 当 Studio 未安排队列时，“队列”面板显示 HQPlayer 自己的播放列表（只读），高亮当前曲目。
- 探测器 v0.1.1：数值属性不再脱敏（修复 `album` 标志被隐藏），并记录 `file:` 前缀的确切形式。
