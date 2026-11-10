# HQPlayer Control API — 协议事实与能力矩阵

> 状态：**Phase 0 / 尚未在 Desktop 6 真机上执行任何命令**。最后更新：2026-11-10。
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

### 需要真机确认的假设

1. `Status` 的 `position` / `length` 单位（推测为秒，double）。
2. `track` / `SelectTrack index` / `PlaylistRemove index` 是 0 基还是 1 基。
3. `Status subscribe="1"` 的推送频率（定时 vs 变化时），以及 `subscribe="0"` 是否会取消订阅。
4. `Pause` 是切换还是幂等暂停。
5. `PlaylistAdd` 的 `queued` / `clear` / `start` 语义；中文/日文/空格路径应传原生路径还是 `file:///` URI，是否需要百分号编码。
6. 未认证连接下 `Status` 的 `<metadata>` 是给出 `uri` 还是 `secure_uri`（后者需要会话密钥，Studio 拿不到 → 只能用曲名匹配）。
7. Album / Playlist 模式：SDK 只在 `PlaylistGet` 响应里给出只读 `album="0|1"`，**没有切换命令**。
8. 多个控制客户端（HQPlayer 原生 UI、Roon、其他遥控器）同时操作时的行为。
9. 同一 TCP 连接上命令是否严格按序应答（Studio 已强制单飞串行，不依赖此假设）。

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

| Capability                       | 来源证据                                                                                | Desktop 6 实测 | 结果/限制                         | 实现决策                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- | -------------- | --------------------------------- | ----------------------------------------- |
| Connect / Get status             | SDK `connectToHost`, `GetInfo`, `Status`, `State`                                       | pending        | 仅知道 TCP 4321 可达              | Live adapter 只读连接；Gate A/B 探测      |
| Current title / elapsed          | SDK `Status` + `<metadata song/artist/album>`，`position`/`length`                      | pending        | 单位待确认；未认证时 URI 可能加密 | 按 URI 匹配库，失败时显示引擎报告的文本   |
| Play / Pause / Stop              | SDK `Play last=`, `Pause`, `Stop`                                                       | pending        | Pause 语义待确认                  | 默认禁用（untested）；Gate C 后开启       |
| Next / Previous / Seek           | SDK `Next`, `Previous`, `Seek position=<int>`                                           | pending        | Seek 单位待确认                   | 同上                                      |
| Load local track / album         | SDK `PlaylistClear` + `PlaylistAdd uri=` + `SelectTrack`                                | pending        | CJK/空格路径编码待确认            | 同上；优先原生路径（与 CLI 一致）         |
| Playlist read / load / save      | SDK `PlaylistGetList/Load/Save/Delete` + 社区帖                                         | pending        | —                                 | Studio 自建播放列表为准；服务端列表为可选 |
| Queue edit / shuffle / repeat    | SDK `PlaylistRemove/MoveUp/MoveDown`, `SetRandom`, `SetRepeat`                          | pending        | “Play Next” 无直接命令            | Live adapter 暂不实现 Play Next           |
| 1x / Nx filters / modulator      | SDK `GetFilters` (`arg` 区分 1x/Nx)、`SetFilter value value1x`、`GetShapers/SetShaping` | pending        | —                                 | Phase 0/1 只读展示；写入永不自动          |
| PCM/SDM mode / output rate       | SDK `GetModes/SetMode`, `GetRates/SetRate`, `Status active_mode/active_rate`            | pending        | —                                 | 只读展示                                  |
| Native device / ASIO / NAA setup | SDK 无对应命令（仅 `ConfigurationLoad` 整体切换配置，需会话）                           | pending        | 需原生 UI                         | 显示 “Requires native HQPlayer settings”  |
| Convolution / Matrix / CUDA      | `SetConvolution`, `MatrixListProfiles/Get/SetProfile`；CUDA 无命令                      | pending        | —                                 | 不改配置文件；只读展示 Matrix profile     |
| Album / Playlist mode            | `PlaylistGet album="0                                                                   | 1"`（只读）    | pending                           | **SDK 无切换命令** → `unsupported`        | “播放整张专辑”按碟/曲序装载，提示无法保证 Gapless |

运行时的同一矩阵见 `packages/hqplayer-adapter/src/live/capability-matrix.ts`（`DESKTOP6_EVIDENCE`），应用设置页 “播放与引擎能力” 会显示每项的等级。

## 6. 探测计划与工具

- **Gate A/B（无副作用）**：`hqp-probe.exe`（CI 构建，单文件，无需安装 Node）。见 `scripts/hqp-probe/README-WINDOWS.txt`。
  - TCP 连接 → 被动监听 750 ms（看是否有欢迎报文）→ 依次发送 19 条只读命令 → `Status subscribe="1"` 观察 3 秒推送 → 断开。
  - 报告默认脱敏：曲名、路径、播放列表名、实例名、配置名等替换为结构描述（如 `[redacted path scheme=native-drive depth=4 ext=flac nonAscii=yes pct=no …]`），保留回答上面“假设 5”所需的信息。
- **Gate C（有副作用）**：未实现开关。需要用户明确同意 + 指定测试专辑后，再以 `LiveHQPlayerAdapter({ policy: { allowUntestedWrites: true } })` 的方式逐项验证。
- **fixtures**：`fixtures/hqplayer-protocol/` 目前为空；收到真实报告后，只提交脱敏后的请求/响应样本。
