# HQP Studio 安装与上手 / Getting started

适用版本 / For version **0.6.0-beta** and later · [中文](#中文) · [English](#english)

HQP Studio（HQPlayer Studio）是 **HQPlayer Desktop 6** 的第三方音乐库、播放列表和遥控器，与 Signalyst 没有任何隶属关系。
声音、DSP、升频（例如 PCM → DSD512）、CUDA 和 DAC 输出始终由 HQPlayer 完成；Studio 负责找音乐、排队和遥控。

HQP Studio is an unofficial library, playlist manager and remote for **HQPlayer Desktop 6**, not affiliated with Signalyst.
HQPlayer still does all the sound; Studio finds your music, keeps the queue and remote-controls HQPlayer.

---

## 中文

### 0. 你需要准备什么

| 项目            | 要求                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| 电脑            | Windows 10 或 11，64 位                                                                                  |
| HQPlayer        | **HQPlayer Desktop 6**（试用版或已授权），装在**同一台电脑**上                                           |
| 音乐            | 音乐文件夹：本地硬盘、USB 盘或 NAS 共享都可以（FLAC、WAV、DSF、DFF、ALAC、MP3 等 HQPlayer 能播放的格式） |
| 手机遥控 (可选) | 和电脑连着同一个家庭 Wi-Fi 的手机或 iPad，用浏览器即可，不需要装 App                                     |

Studio 不包含、不安装、也不破解 HQPlayer。HQPlayer 请从 Signalyst 官网下载：<https://www.signalyst.com/consumer.html>

### 1. 第一步：先让 HQPlayer 自己能出声

Studio 只是遥控 HQPlayer，所以 HQPlayer 必须先单独工作正常：

1. 安装并打开 **HQPlayer Desktop 6**。
2. 打开 HQPlayer 的 **设置（Settings）**，在输出（Backend / Device）里选你的 DAC（例如 ASIO 驱动），设置你常用的模式、滤波器、
   采样率（例如 DSD512）。这些设置以后 Studio 不会动，除非你在 Studio 里明确允许。
3. 如果你想用 Studio 调音量：在 HQPlayer 设置的 **Outputs** 里**取消勾选 “Fixed volume”**（固定音量），否则音量条只能显示、不能调。
4. 在 HQPlayer 里随便打开一首歌播放，确认能听到声音。

### 2. 第二步：安装 HQP Studio

你会收到（或在 GitHub Releases 下载到）下面其中一个文件：

| 文件                                     | 用途                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `HQPlayerStudio-<版本>-setup-x64.exe`    | **安装版（推荐）**。装到当前用户，不需要管理员权限，有开始菜单和桌面图标 |
| `HQPlayerStudio-<版本>-portable-x64.exe` | 免安装版：双击就运行，不安装任何东西                                     |
| `HQPlayerStudio-<版本>-win-x64.zip`      | 解压即用的程序文件夹                                                     |

安装版的步骤：

1. 双击 `…-setup-x64.exe`。
2. 程序没有数字签名，Windows 可能弹出 **“Windows 已保护你的电脑”**：点 **更多信息 → 仍要运行**。
3. 安装程序会问安装位置（默认即可，可以改）。之后会创建开始菜单和桌面快捷方式。
4. 最后一页勾着“运行 HQPlayer Studio”，点 **完成** 就会打开 Studio。

三种方式共用同一个数据文件夹 `%APPDATA%\HQPlayer Studio`（音乐库索引、播放列表、设置、备份、日志）。
升级、换用另一种方式、卸载都不会删除它。

### 3. 第三步：设置向导（第一次打开时自动出现）

第一次打开 Studio 会出现一个 5 步的设置向导。每一项都可以以后在“设置”里改；想先看看界面，可以在第一页点 **“跳过，先看演示”**
（用虚构的演示音乐库和模拟引擎，不会连接 HQPlayer）。以后随时可以在 **设置 → 常规 → 设置向导 → 重新运行设置向导** 再来一次。

#### ① 欢迎

- **语言**：简体中文 / English。
- 向导在点最后的“完成”之前不会连接 HQPlayer，也不会改 HQPlayer 的任何东西。

#### ② HQPlayer（三项检查）

| 检查 / 选项                         | 说明                                                                                                                                                  | 建议             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 找到了 HQPlayer Desktop             | Studio 会在注册表、开始菜单快捷方式、常见安装目录里找。找不到时点 **选择 HQPlayer…** 选 `HQPlayer6Desktop.exe`，或点 **下载 HQPlayer Desktop**        | 必须打勾         |
| HQPlayer 正在运行                   | 没运行就点 **启动 HQPlayer**                                                                                                                          | 必须打勾         |
| 控制接口有回应（127.0.0.1:4321）    | Studio 连一下 HQPlayer 的控制端口再断开，不发任何命令。HQPlayer 刚启动要几秒，点 **再检查一次**                                                       | 必须打勾         |
| 启动 Studio 时自动启动 HQPlayer     | 打开 Studio 时如果 HQPlayer 没运行，就替你打开                                                                                                        | 推荐开           |
| HQPlayer 窗口：正常 / 最小化 / 隐藏 | Studio 启动或找到 HQPlayer 时怎么处理它的窗口。“隐藏”后 HQPlayer 照常在后台播放，可在 设置 → 播放与引擎能力 → HQPlayer 程序 里点“显示 HQPlayer”找回来 | 熟悉后可选“隐藏” |

控制接口没回应怎么办：确认 HQPlayer 真的开着（不只是装了）→ 完全退出 HQPlayer 再打开 → 等几秒点“再检查一次”→
确认没有别的程序（例如另一个 HQPlayer 遥控软件）占用 4321 端口 → 安全软件询问时允许 HQPlayer。
暂时没有 HQPlayer 也可以点 **先用演示模式**。

#### ③ 音乐文件夹

- 点 **添加音乐文件夹…** 选择文件夹，可以添加多个。添加后自动开始扫描，列表里会显示“正在扫描…已发现 N 个文件”，扫描在后台继续，
  可以直接点“下一步”。
- **NAS**：用网络路径，例如 `\\NAS\Music`，比映射盘符（`Z:\`）更可靠。NAS 关机时曲目只会标成“不可用”，不会被删除。
- 扫描**只读文件**，从不移动、改名、删除或改标签。以后文件夹里新增或修改的音乐会被自动发现（另有每天一次的兜底扫描）。
- **删除演示音乐库**：添加了自己的文件夹后可以勾选，完成时删掉虚构的演示专辑（推荐）。

#### ④ 连接与控制

| 选项                                   | 说明                                                                                                                              | 建议                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **真实 HQPlayer** / 演示模式           | 真实 = 连接本机 HQPlayer；演示 = 模拟引擎，没有声音                                                                               | 真实 HQPlayer          |
| **允许 Studio 控制 HQPlayer**          | 播放、暂停、切歌、调音量、把专辑和播放列表送进 HQPlayer。关掉时 Studio 只显示 HQPlayer 的状态。只开放在 HQPlayer 6 上验证过的命令 | 开                     |
| **允许 Studio 修改 HQPlayer DSP 设置** | 在 Studio 里切换模式、1x / Nx 滤波器、调制器、输出采样率、反相、自适应音量，并保存预设。播放中更改会有约 5 秒的短暂中断           | 不确定就先关，以后再开 |

无论怎么选，Studio 都不会改 HQPlayer 的输出设备、许可证或安装，也不上传任何数据。

#### ⑤ 完成

检查一下摘要，点 **完成并重新启动 Studio**（切换到真实 HQPlayer 需要重启一次，几秒钟）。重启后右上角应显示 **“HQPlayer 已连接”**。

### 4. 日常使用

- **播放**：双击专辑、歌曲或播放列表，或者点封面上的播放按钮。Studio 会先停止 HQPlayer，再把曲目放进 HQPlayer 并开始播放。
- **队列**：右侧面板是 Studio 的即时队列（播放条右边的按钮可以打开 / 收起面板）。可以“下一首播放”“加入队列”、拖动排序。
  保存的播放列表与队列分开，播放不会改动播放列表。
- **队列不一致**：如果有人在 HQPlayer 自己的窗口里换了歌，Studio 会提示“队列不一致”，由你选 **以 HQPlayer 为准**（Studio 跟随）
  或 **用 Studio 队列替换 HQPlayer**（不会自动播放）。Studio 从不静默覆盖。
- **播放列表**：侧栏“播放列表”新建；在专辑 / 歌曲上右键或点“…”加入。
- **搜索**：顶部搜索框，或按 `Ctrl + K` / `/`。
- **快捷键**：空格 = 播放 / 暂停；`Ctrl + →` / `Ctrl + ←` = 下一首 / 上一首。
- **迷你播放器**：播放条上的迷你播放器按钮，小窗可置顶，会记住位置。
- **媒体键和托盘**：设置 → 常规 → 桌面集成：键盘媒体键、托盘图标、关闭窗口时最小化到托盘。
- **主题**：设置 → 常规 → 主题（多种配色）。

### 5. 手机 / iPad 遥控

1. 电脑上：**设置 → 网页遥控** → 打开 **允许局域网内的手机/平板访问** → 选择你家的网络（只会在家庭局域网地址上监听）。
2. 第一次 Windows 可能弹出“Windows 安全中心警报”：**只勾选“专用网络”**，点“允许访问”。如果手机打不开页面，在 Windows
   设置 → 网络和 Internet 里确认这个网络是“专用”。
3. 点 **生成配对码**：手机扫二维码（会自动带上配对码），或在手机浏览器里输入页面上显示的地址和 6 位配对码。
4. 可以把页面“添加到主屏幕”，用起来像 App。
5. 手机能浏览、播放、切歌、改队列，但永远拿不到设置、诊断、文件夹管理或文件路径。设备列表里可以随时取消某台设备的配对。
   网页遥控在家庭网络里用的是不加密的 HTTP：只在你信任的网络里打开，**不要把端口映射到公网**。

### 6. DSP 设置与预设

在向导或 **设置 → DSP** 打开“允许 Studio 修改 HQPlayer DSP 设置”后，可以改模式（PCM / SDM）、1x / Nx 滤波器、
调制器 / 噪声整形、输出采样率、反相和自适应音量。每次更改都会从 HQPlayer 读回确认；播放中更改会有短暂中断，约 5 秒后生效。

**预设**：同一页 **把当前设置存为预设…**，起个名字（例如“DSD512 夜间”），以后选中点 **应用** 一次切换全部。
如果 HQPlayer 里已经没有预设中的某个滤波器或采样率，Studio 会说明是哪一项，不会改动任何设置。

输出设备、缓冲、卷积、矩阵、CUDA 只能在 HQPlayer 自己的设置里改。

### 7. 均衡器（EQ）

Studio 把你画的 EQ 曲线写成一个滤波器文件，由 HQPlayer 自己的卷积引擎处理（声音仍然全部由 HQPlayer 处理）。
**设置 → EQ**：

1. 调好曲线后点一次 **应用**，生成滤波器文件。
2. **一次性设置**：在 HQPlayer 设置的卷积（Convolution）部分，把页面上显示的文件（可点“复制路径”）设为左右两个声道的
   脉冲响应（增益 0 dB），勾选卷积并确定。
3. 播放音乐，运行页面上的 **试听检查**：Studio 会临时放入一个明显削减高音的测试滤波器，问你“音乐是不是变闷了”，
   用来确认 HQPlayer 会读取更新后的文件。回答后（或 2 分钟后）你的 EQ 自动恢复。
4. 以后改曲线只需点“应用”。要在 Studio 里开关卷积，需要同时允许修改 DSP 设置。

### 8. 歌词与封面

- 歌词优先用本地文件：与歌曲同名的 `.lrc`、文件内嵌歌词。点播放条上的歌词按钮在右侧面板显示，可用 − / + 校准时间。
- **在线歌词**（LRCLIB、网易云、酷狗、lyrics.ovh）默认关闭，在 **设置 → 歌词** 逐个开启；开启后只为正在播放的那一首查询，
  只发送歌名 / 歌手 / 专辑 / 时长。
- **在线封面**（iTunes、Deezer、MusicBrainz）默认关闭，在 **设置 → 音乐库 → 封面** 开启。已有本地封面的专辑不会被替换。

### 9. Apple Music（实验功能）

侧栏 **Apple Music**：让 Apple Music 应用的声音经过 HQPlayer 升频。需要：Windows 上的 Apple Music 应用、一个虚拟声卡
（例如 VB-Audio 的虚拟线缆，需要自己安装）、在 HQPlayer 设置里把输入设为这个虚拟声卡。页面上的 **检查这台电脑** 会逐项告诉你
缺什么，并提供打开 Windows 声音设置 / 音量合成器 / 隐私设置的按钮。这不是逐位精确播放（声音经过 Windows 混音器），
声音会比 Apple Music 应用晚几秒。

### 10. 备份、升级、卸载

- **备份**：设置 → 常规 → 数据备份。每天自动一份、每次升级前自动一份；也可点 **立即备份**。**恢复…** 可以选一份备份恢复，
  恢复前的数据也会先存一份，所以恢复可以撤销。备份只包括音乐库索引、播放列表、队列和设置，不包括音乐文件。
- **升级**：直接安装新版本，不需要先卸载。Studio 不会自动更新自己。
- **退回旧版本**：安装旧版本即可；如果数据库已被新版本升级，旧版本会提示并提供“恢复这个备份”。
- **卸载**：Windows 设置 → 应用 → HQPlayer Studio → 卸载。数据文件夹 `%APPDATA%\HQPlayer Studio` 会保留；
  如果确定不再使用，可以手动删除它。卸载 Studio 不影响 HQPlayer。

### 11. 常见问题

| 现象                                | 处理                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶栏显示 “MOCK 引擎”                | 还在演示模式：设置 → 播放与引擎能力 → 引擎连接 → 真实 HQPlayer（实验） → 立即重启（或重新运行设置向导）                                              |
| 显示“HQPlayer 未连接”               | 打开 HQPlayer；或在 设置 → 播放与引擎能力 打开“启动 Studio 时自动启动 HQPlayer”。Studio 会自动重连，重连后不会自动播放                               |
| 播放按钮是灰的 / 提示没有权限       | 打开 设置 → 播放与引擎能力 → **允许 Studio 控制 HQPlayer**                                                                                           |
| 能播放但没有声音                    | 是 HQPlayer 的输出问题：在 HQPlayer 里直接播放一首歌检查输出设备 / DAC                                                                               |
| 音量条不能拖                        | HQPlayer 设置 → Outputs → 取消 **Fixed volume**                                                                                                      |
| 某个文件夹扫描不到 / NAS 显示不可用 | 设置 → 音乐库 看该文件夹的错误；NAS 请用 `\\NAS\共享名` 路径，并确认 Windows 能在资源管理器里打开它                                                  |
| 手机打不开遥控页面                  | 电脑和手机在同一 Wi-Fi；网络设为“专用”；防火墙提示时允许“专用网络”；配对码过期就生成新的                                                             |
| HQPlayer 窗口被隐藏了找不到         | 设置 → 播放与引擎能力 → HQPlayer 程序 → 显示 HQPlayer                                                                                                |
| 想重新设置                          | 设置 → 常规 → 设置向导 → 重新运行设置向导                                                                                                            |
| 出了问题想发给开发者                | 设置 → 诊断 → **复制诊断信息**，粘贴发送；需要时点“打开日志文件夹”，附上 `studio.log` 和 `crash-*.txt`。这些内容已去掉文件路径、曲名、电脑名和用户名 |

### 12. 隐私

Studio 不上传任何数据。只有你开启的在线歌词 / 封面来源会收到歌名、歌手、专辑名（从不发送路径）。
日志、崩溃报告、诊断信息都留在你的电脑上，是否发给别人由你决定。

更详细的说明（版本回退、长时间播放测试等）见 [用户指南](user-guide.md)。

---

## English

### 0. What you need

| Item              | Requirement                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| PC                | Windows 10 or 11, 64-bit                                                          |
| HQPlayer          | **HQPlayer Desktop 6** (trial or licensed) on the **same PC**                     |
| Music             | Music folders on a local disk, USB drive or NAS share (any format HQPlayer plays) |
| Remote (optional) | A phone or iPad on the same home Wi-Fi; it uses the browser, no app to install    |

Studio does not include or install HQPlayer. Get it from Signalyst: <https://www.signalyst.com/consumer.html>

### 1. First: make HQPlayer play on its own

1. Install and open **HQPlayer Desktop 6**.
2. In HQPlayer's **Settings**, choose your DAC as the output (backend / device, e.g. the ASIO driver) and your usual mode,
   filter and rate (e.g. DSD512). Studio leaves these alone unless you allow it to change DSP settings.
3. To use Studio's volume control, untick **"Fixed volume"** in HQPlayer's settings under **Outputs**; otherwise the volume can only be shown.
4. Play any song in HQPlayer and check that you hear it.

### 2. Install HQP Studio

| File                                        | Use                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `HQPlayerStudio-<version>-setup-x64.exe`    | **Installer (recommended)**: per-user, no admin rights, Start menu + desktop icon |
| `HQPlayerStudio-<version>-portable-x64.exe` | Portable: double-click to run, nothing installed                                  |
| `HQPlayerStudio-<version>-win-x64.zip`      | The unpacked app                                                                  |

1. Double-click `…-setup-x64.exe`.
2. The program is not code-signed: if Windows says **"Windows protected your PC"**, choose **More info → Run anyway**.
3. Keep the suggested install folder (or change it). Shortcuts are created in the Start menu and on the desktop.
4. Leave "Run HQPlayer Studio" ticked on the last page and press **Finish**.

All three share the data folder `%APPDATA%\HQPlayer Studio` (library index, playlists, settings, backups, logs); updating,
switching or uninstalling keeps it.

### 3. The setup wizard (opens on the first start)

A five-step wizard opens the first time. Everything in it can be changed later in Settings. To look around first, press
**"Skip, show me the demo"** on the first page (made-up demo library, mock engine, HQPlayer untouched). Run it again any time
from **Settings → General → Setup wizard → Run setup again**.

#### ① Welcome

- **Language**: 简体中文 / English.
- Nothing reaches HQPlayer until you press "Finish" at the end.

#### ② HQPlayer (three checks)

| Check / option                               | What it means                                                                                                                                                                        | Recommended                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| HQPlayer Desktop found                       | Studio looks in the registry, Start-menu shortcuts and the usual folders. If not found, press **Choose HQPlayer…** and pick `HQPlayer6Desktop.exe`, or **Download HQPlayer Desktop** | must be ticked                   |
| HQPlayer is running                          | If not, press **Start HQPlayer**                                                                                                                                                     | must be ticked                   |
| Control interface answers (127.0.0.1:4321)   | Studio connects to HQPlayer's control port and disconnects, sending no command. HQPlayer needs a few seconds after starting: press **Check again**                                   | must be ticked                   |
| Start HQPlayer when Studio starts            | Studio opens HQPlayer if it is not running yet                                                                                                                                       | on                               |
| HQPlayer window: normal / minimized / hidden | What Studio does with HQPlayer's window. A hidden HQPlayer keeps playing; bring it back from Settings → Playback & engine capabilities → HQPlayer program → Show                     | "hidden" once you are used to it |

If the control interface does not answer: make sure HQPlayer is actually open → quit it completely and reopen → wait a few
seconds and press "Check again" → make sure no other program (e.g. another HQPlayer remote) uses port 4321 → allow HQPlayer if
security software asks. No HQPlayer yet? Press **Use demo mode**.

#### ③ Music folders

- **Add music folder…**, as many as you like. Each one is scanned right away ("Scanning… N files found"); scanning continues in
  the background, so you can go on.
- **NAS**: use the network path, e.g. `\\NAS\Music`, rather than a mapped drive letter. When the NAS is off, its tracks are
  marked unavailable, never deleted.
- Scans only read: nothing is moved, renamed, deleted or retagged. New or changed music is picked up automatically later (plus a daily fallback scan).
- **Remove the demo library**: once you added a folder of your own, tick it to drop the made-up demo albums (recommended).

#### ④ Connection and control

| Option                                           | What it means                                                                                                                                                  | Recommended                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Real HQPlayer** / demo mode                    | Real = HQPlayer on this PC; demo = mock engine, no sound                                                                                                       | Real HQPlayer                |
| **Allow Studio to control HQPlayer**             | Play, pause, skip, volume, send albums and playlists to HQPlayer. Off = Studio only shows what HQPlayer does. Only commands verified on HQPlayer 6 are offered | on                           |
| **Allow Studio to change HQPlayer DSP settings** | Mode, 1x / Nx filters, modulator, output rate, invert, adaptive volume and presets from Studio. A change while playing causes a short gap (~5 s)               | off if unsure; turn on later |

Studio never changes HQPlayer's output device, licence or installation, and uploads nothing.

#### ⑤ Done

Check the summary and press **Finish and restart Studio** (switching to the real HQPlayer needs one restart, a few seconds).
Afterwards the top bar should say **"HQPlayer connected"**.

### 4. Everyday use

- **Play**: double-click an album, track or playlist, or use the play button on a cover. Studio stops HQPlayer, loads the tracks into it and starts playback.
- **Queue**: the right-hand panel (toggle it with the button at the right of the player bar). "Play next", "Add to queue", drag to reorder.
  Saved playlists are separate from the queue; playing never changes a playlist.
- **Out of sync**: if someone changes tracks in HQPlayer's own window, Studio says so and lets you choose **Follow HQPlayer** or
  **Replace HQPlayer's queue** (no autoplay). Nothing is overwritten silently.
- **Playlists**: create them under "Playlists"; add albums or tracks with right-click or "…".
- **Search**: the box at the top, or `Ctrl + K` / `/`.
- **Keys**: Space = play / pause; `Ctrl + →` / `Ctrl + ←` = next / previous.
- **Mini Player**: button on the player bar; optionally always on top, remembers its place.
- **Media keys and tray**: Settings → General → Desktop integration.
- **Themes**: Settings → General → Theme.

### 5. Phone / tablet remote

1. On the PC: **Settings → Web Remote** → turn on **Allow phones and tablets on the LAN** → choose your home network.
2. The first time Windows may show a "Windows Security Alert": tick **only "Private networks"** and click "Allow access". If the
   phone cannot open the page, check in Windows Settings → Network & internet that this network is "Private".
3. Press **Create pairing code**: scan the QR code with the phone (it carries the code), or open the shown address and type the 6-digit code.
4. "Add to Home Screen" makes it feel like an app.
5. Phones can browse, play, skip and edit the queue, but never get settings, diagnostics, folder management or file paths.
   Unpair devices any time. The remote uses plain HTTP inside your home network: only turn it on for a network you trust, and
   **never forward the port to the internet**.

### 6. DSP settings and presets

With "Allow Studio to change HQPlayer DSP settings" on (wizard or **Settings → DSP**): mode (PCM / SDM), 1x / Nx filters,
modulator / noise shaping, output rate, invert and adaptive volume. Each change is read back from HQPlayer; while playing there is
a short gap and it applies after about 5 seconds.

**Presets**: **Save current settings as preset…**, give it a name (e.g. "DSD512 night"), then **Apply** it later to switch everything
at once. If HQPlayer no longer offers an item of the preset, Studio names it and changes nothing.

Output device, buffers, convolution, matrix and CUDA stay in HQPlayer's own settings.

### 7. Equalizer (EQ)

Studio turns your EQ curve into a filter file that HQPlayer plays through its own convolution engine. **Settings → EQ**:

1. Shape the curve and press **Apply** once, so the filter file exists.
2. **One-time setup in HQPlayer**: in the convolution section of HQPlayer's settings, choose the file shown on the page ("Copy path")
   as the impulse response for the left and right channels (gain 0 dB), tick convolution and press OK.
3. With music playing, run the **Listening check**: Studio briefly puts in a strong treble-cut test filter and asks whether the music
   sounds muffled, to confirm HQPlayer loads changes. Your EQ goes back as soon as you answer (or after 2 minutes).
4. From then on just press "Apply". Switching convolution from Studio also needs DSP changes allowed.

### 8. Lyrics and covers

- Local lyrics first: a `.lrc` with the song's name, or lyrics embedded in the file. Open the lyrics panel from the player bar; − / + adjusts timing.
- **Online lyrics** (LRCLIB, NetEase, Kugou, lyrics.ovh) are off until you enable them one by one in **Settings → Lyrics**; then only
  the playing track is looked up (title / artist / album / duration).
- **Online covers** (iTunes, Deezer, MusicBrainz) are off until enabled in **Settings → Library → Covers**. Local covers are never replaced.

### 9. Apple Music (experimental)

**Apple Music** in the sidebar sends the Apple Music app's sound through HQPlayer. You need the Apple Music app for Windows, a
virtual audio cable (e.g. VB-Audio's, installed by you) and HQPlayer's input set to that cable in HQPlayer's settings.
**Check this PC** on that page lists what is missing and opens the right Windows settings. It is not bit-perfect (the sound
passes the Windows mixer) and is a few seconds behind the Apple Music app.

### 10. Backups, updates, uninstalling

- **Backups**: Settings → General → Data backups. One a day and one before each update, automatically; **Back up now** any time.
  **Restore…** brings one back (the current data is saved first, so a restore can be undone). Backups hold the library index,
  playlists, queue and settings, not music files.
- **Update**: install the new version over the old one. Studio never updates itself.
- **Going back**: install the older version; if the newer one upgraded the database, the older one says so and offers to restore the pre-update backup.
- **Uninstall**: Windows Settings → Apps → HQPlayer Studio → Uninstall. `%APPDATA%\HQPlayer Studio` stays; delete it yourself if you
  are done with Studio. Uninstalling Studio does not touch HQPlayer.

### 11. Troubleshooting

| Symptom                                   | What to do                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Top bar says "MOCK engine"                | Still in demo mode: Settings → Playback & engine capabilities → Engine connection → Real HQPlayer (experimental) → Restart now (or run the wizard again)                             |
| "HQPlayer not connected"                  | Open HQPlayer, or turn on "Start HQPlayer when Studio starts". Studio reconnects by itself and never starts playback on reconnect                                                    |
| Play buttons greyed out / not allowed     | Settings → Playback & engine capabilities → **Allow Studio to control HQPlayer**                                                                                                     |
| Plays but no sound                        | HQPlayer's output: play a song in HQPlayer itself and check its output device / DAC                                                                                                  |
| Volume slider does not move               | HQPlayer Settings → Outputs → untick **Fixed volume**                                                                                                                                |
| A folder is not scanned / NAS unavailable | See the folder's error under Settings → Library; use `\\NAS\share` and make sure Windows Explorer can open it                                                                        |
| Phone cannot open the remote              | Same Wi-Fi; network set to "Private"; allow "Private networks" in the firewall prompt; create a new code if it expired                                                               |
| Hidden HQPlayer window                    | Settings → Playback & engine capabilities → HQPlayer program → Show HQPlayer                                                                                                         |
| Start over                                | Settings → General → Setup wizard → Run setup again                                                                                                                                  |
| Something went wrong                      | Settings → Diagnostics → **Copy diagnostics** and send it; if asked, "Open log folder" and attach `studio.log` and `crash-*.txt`. Paths, titles, computer and user names are removed |

### 12. Privacy

Studio uploads nothing. Only the online lyrics / cover sources you enable receive track or album names (never paths). Logs,
crash reports and diagnostics stay on your PC; sending them is your choice.

More detail (going back to an older version, the long listening test, …) in the [user guide](user-guide.md#english).
