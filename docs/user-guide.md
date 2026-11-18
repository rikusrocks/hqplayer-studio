# HQPlayer Studio 用户指南 / User guide

适用版本 / For version **0.5.0**. [中文](#中文) · [English](#english)

HQPlayer Studio 是 **HQPlayer Desktop 6** 的第三方音乐库、播放列表和遥控器，与 Signalyst 没有任何隶属关系。
声音、DSP、升频（例如 PCM → DSD512）、CUDA 和 DAC 输出始终由 HQPlayer 完成；Studio 只负责找音乐、排队和遥控。

---

## 中文

### 1. 安装、升级、卸载

从 GitHub 的 **Releases**（正式版本）或 **Actions → Windows build → Artifacts**（每次修改后的测试版本）下载：

| 文件                                     | 用途                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `HQPlayerStudio-<版本>-setup-x64.exe`    | **安装版（推荐）**。安装到当前用户，不需要管理员权限；有开始菜单和桌面快捷方式 |
| `HQPlayerStudio-<版本>-portable-x64.exe` | 免安装版：双击即运行，什么都不安装                                             |
| `HQPlayerStudio-<版本>-win-x64.zip`      | 解压即用的程序文件夹                                                           |

- 程序没有数字签名。第一次运行时如果 Windows 提示“已保护你的电脑”，点 **更多信息 → 仍要运行**。
- 三种方式共用同一个数据文件夹 `%APPDATA%\HQPlayer Studio`：音乐库索引、播放列表、设置、备份、日志都在这里。
  换用另一种方式、升级或卸载都不会丢失这些数据（卸载程序不会删除数据文件夹）。
- **升级**：直接安装新版本（或换用新的免安装 exe）。如果新版本需要改动数据库，会先自动做一份“升级前自动备份”。
- Studio 不会自动更新自己，也不会更新、重装或修改 HQPlayer。

### 2. 第一次使用：连接 HQPlayer

第一次打开时会出现 **设置向导**（检查 HQPlayer、添加音乐文件夹、选择连接与控制权限），每一项的说明见
[安装与上手](getting-started.md#3-第三步设置向导第一次打开时自动出现)；随时可在 **设置 → 常规 → 设置向导** 重新运行。下面是不用向导、手动设置的方法：

1. 跳过向导时 Studio 使用 **Mock 引擎**和一个虚构的演示音乐库，不会碰 HQPlayer。
2. **设置 → 播放与引擎能力 → 引擎连接**：选择“真实 HQPlayer（实验）”，点“立即重启”。Studio 只连接本机的
   `127.0.0.1:4321`，先只读取状态。
3. 想用 Studio 播放、暂停、切歌、装载专辑：在同一页打开 **允许 Studio 控制 HQPlayer**。只有在你的 HQPlayer 上验证过的
   命令才会开放；不支持的功能会写明原因，不会显示假按钮。
4. 可选：同一页的 **HQPlayer 程序** —— “启动 Studio 时自动启动 HQPlayer”，以及 HQPlayer 窗口“正常 / 最小化 / 隐藏”。
   “最近一次结果”会显示每一步发生了什么。
5. HQPlayer 断开后，Studio 会自动重连，**只重新读取状态**：不会自动播放、不会改音量或 DSP。

### 3. 音乐库

- **设置 → 音乐库 → 添加目录**，选择音乐文件夹后点“扫描”。支持本地盘、USB 盘和网络共享（NAS）。
- 之后 Studio 会监听文件夹的变化，只重新扫描改动过的文件夹；另有每天一次的兜底扫描。播放时扫描会主动放慢，
  不与 HQPlayer 争抢磁盘或 CPU。
- 扫描只读文件。文件暂时找不到（例如 NAS 关机）只标记为“不可用”，不会删除；被播放列表引用的曲目永远不会被删除。
- 封面优先用文件夹里的图片和文件内嵌图片。在线封面（iTunes / Deezer / MusicBrainz）默认关闭，在 **设置 → 音乐库 → 封面** 开启。

### 4. 播放、队列、播放列表

- 在专辑、播放列表或歌曲上点播放：Studio 先停止 HQPlayer，再把曲目放进 HQPlayer 的播放列表并开始播放。
- 右侧“队列”是 Studio 安排的即时队列；保存的播放列表与队列分开，播放不会改动播放列表。
- 如果有人在 HQPlayer 自己的窗口里换了歌，Studio 会显示“队列不一致”，由你选择：**以 HQPlayer 为准**（Studio 跟随，
  不向 HQPlayer 发命令）或 **用 Studio 队列替换 HQPlayer**（不会自动开始播放）。Studio 从不静默覆盖。

### 5. 迷你播放器、媒体键、托盘、歌词

- 播放条上的迷你播放器按钮打开一个小窗口（可置顶，记住位置，多显示器会自动拉回屏幕内）。
- **设置 → 常规 → 桌面集成**：媒体键（Windows）、托盘图标、关闭窗口时最小化到托盘。
- 歌词优先使用本地文件（与音乐同名的 `.lrc`、`Lyrics` 子文件夹等）和文件内嵌歌词。在线歌词来源（LRCLIB、网易云、酷狗、
  lyrics.ovh）默认关闭，在 **设置 → 歌词** 逐个开启；开启后只为正在播放的那一首查询。每首歌可以用 − / + 校准时间。

### 6. 手机 / iPad 遥控

1. **设置 → 网页遥控**：开启局域网访问，选择家里的网络（只会在家庭局域网地址上监听）。
2. 手机浏览器打开页面上显示的地址（或扫二维码），输入电脑上显示的 6 位配对码。
3. 设备列表里可以随时取消某台设备的配对。手机能浏览、播放、切歌、改队列，但永远拿不到设置、诊断、文件夹管理或文件路径。
   请不要把这个端口映射到公网。
4. **电脑上能打开、手机打不开？** 有些 Wi-Fi 网卡（例如 MediaTek MT7902）在节能时不回应“谁是这个地址”的询问，
   手机就找不到电脑。Studio 会定期向已配对的手机（以及显示配对码时向整个家庭网段）发一个空的小数据包，让手机记住电脑的位置。
   要彻底解决：在电脑的 设备管理器 → 网络适配器 → 你的 Wi-Fi 网卡 → 属性 里，“电源管理”取消“允许计算机关闭此设备以节约电源”，
   “高级”里把 ARP Offload / NS Offload / Packet Coalescing 设为 Disabled；或者用网线连接电脑。

### 7. DSP 设置

**设置 → DSP**：在开启“允许 Studio 控制 HQPlayer”之后，再开启“允许 Studio 修改 HQPlayer DSP 设置”，就可以改模式、1x / Nx
滤波器、调制器 / 噪声整形、输出采样率、反相和自适应音量。每次更改都会从 HQPlayer 读回确认。播放中更改会有短暂中断，
约 5 秒内生效。输出设备、缓冲、卷积、矩阵、CUDA 等只能在 HQPlayer 自己的设置窗口里改。

**预设**：同一页下方“把当前设置存为预设…”，起个名字（例如“DSD512 夜间”）；以后选中它点“应用”就会一次切换模式、滤波器、
调制器、采样率、反相和自适应音量。如果 HQPlayer 里已经没有预设中的某个滤波器或采样率，Studio 会说明是哪一项，
不会改动任何设置。

**均衡器（设置 → 均衡器）**：HQPlayer 没有 EQ 命令，所以 Studio 把你的 EQ 曲线写成一个滤波器文件（WAV 脉冲响应），
由 HQPlayer 自己的卷积引擎处理。一次性设置：先点一次“应用”，再在 HQPlayer 的卷积设置里把页面上显示的文件选为左右声道的
脉冲响应（增益 0 dB）并勾选卷积。之后在 Studio 里调频段（峰值 / 高低架 / 高低通）、载入预设或粘贴 AutoEQ 的
ParametricEQ.txt，点“应用”即可。有提升时 Studio 会自动降低前级增益，曲线不会超过 0 dB。开启 DSP 开关后，Studio 也能
切换 HQPlayer 的卷积，并在应用时把卷积关闭再打开，让 HQPlayer 载入新曲线。“试听检查”会放入一个只会让声音变小的测试
滤波器，问你是否听到声音发闷，以确认这一点；回答后（或 2 分钟后）自动恢复你的 EQ。

### 8. 数据备份与恢复

**设置 → 常规 → 数据备份**

- 备份内容：音乐库索引、播放列表、队列、Studio 的设置（不含音乐文件，也不含封面缓存）。备份只保存在这台电脑上：
  `%APPDATA%\HQPlayer Studio\data\backups`。
- 自动备份：每次升级改动数据库**之前**一份（“升级前自动备份”）；每天一份（播放时会等到暂停，最多推迟一天）。
  每种只保留最近几份（每日 7 份、升级前 5 份、手动 10 份、恢复前的数据 5 份）。
- **立即备份**：随时手动备份一份。
- **恢复…**：选一份备份 → 确认 → Studio 重新启动并换上这份备份。当前数据会先另存为“恢复前的数据”，所以恢复也可以撤销。
  HQPlayer 不受影响。

**HQPlayer 设置备份（设置 → 播放）**

- Studio 会在 HQPlayer 的设置文件（`%LOCALAPPDATA%\HQPlayer\settings.xml`：输出设备、缓冲、输入、音量、DSP、卷积 / 矩阵……）
  每次变化时自动保存一份副本，放在 `%APPDATA%\HQPlayer Studio\hqplayer-settings-backups`。备份只读取文件，不改动 HQPlayer。
- 如果 HQPlayer 某次变成了空白的默认设置，所有页面顶部会出现提示，点“恢复”即可。也可以在列表里选任意一份副本恢复。
- 恢复时 Studio 会先正常关闭 HQPlayer（正在播放的音乐会停止），把当前设置另存一份，写回副本，再重新启动 HQPlayer。
  如果 HQPlayer 没有退出，Studio 不会改动文件，请手动关闭 HQPlayer 后再点“恢复”。
- “固定”可以让某份副本永久保留（默认保留最近 30 份，以及设置最完整的一份）。

### 9. 退回旧版本

1. 退出 Studio，安装（或运行）旧版本。
2. 如果新版本改过数据库，旧版本（0.5.0 及以后）启动时会提示 **“这个数据库来自更新版本的 HQPlayer Studio”**，
   不会打开或改动它，并提供“恢复这个备份”：这是新版本升级前自动做的那份备份。点它即可，当前（新版本的）数据库会
   另存为备份，之后再换回新版本时还能恢复。
3. 注意：升级之后才做的改动（新建的播放列表等）不在升级前的备份里。
4. 0.5.0 没有改动数据库结构，所以从 0.5.0 退回 0.4.x 可以直接运行；0.4.x 及更早的版本还没有上面的保护。

### 10. 日志、崩溃报告、诊断信息

- Studio 把运行记录写在 `%APPDATA%\HQPlayer Studio\logs`：`studio.log`（满 2 MB 轮换，保留 5 个文件）、
  崩溃报告 `crash-*.txt`。写入前会去掉文件路径、文件名、曲名、歌手、专辑、电脑名、用户名和局域网地址。不会上传到任何地方。
- 如果 Studio 上次没有正常退出（崩溃、被强制结束或断电），下次启动时会记录下来，并在 **设置 → 诊断 → 日志与崩溃报告** 显示。
- 界面窗口如果崩溃，Studio 会自动重新载入（10 分钟内最多 3 次）并记录原因。
- 遇到问题：**设置 → 诊断 → 复制诊断信息**，把内容发给开发者。里面包括连接状态、最近与 HQPlayer 的通信（已脱敏）、
  最近的警告与错误、数据库与备份状态、长时间播放测试的结论。需要更多细节时可以点“打开日志文件夹”，把 `studio.log`
  和 `crash-*.txt` 一起发回。

### 11. 长时间播放测试（检验 Studio 会不会影响播放）

这个测试只“旁听”：记录 HQPlayer 的状态是否中断、播放是否在 Studio 没有发命令时停止或跳曲、扫描音乐库时是否出问题、
Studio 自己是否卡顿。它不会向 HQPlayer 发送任何命令，也不会改任何设置。

1. 确认 Studio 已连接真实 HQPlayer（**设置 → 播放与引擎能力**），并开启了“允许 Studio 控制 HQPlayer”。
2. **设置 → 诊断 → 长时间播放测试**：选择时长（例如“8 小时”或“直到我停止”），点 **开始测试**。
3. 在 Studio 里播放专辑或播放列表，按平常的方式听（最好用你常用的 DSD512 设置）。测试期间可以照常使用 Studio 和手机遥控。
4. 为了检验“扫描时播放是否受影响”，测试期间请至少做一次：
   - 往音乐文件夹里复制一张新专辑（触发文件夹监听扫描），以及
   - **设置 → 音乐库** 点一次“扫描”（完整的增量扫描）。
5. 如果听到任何问题（爆音、断音、停止、跳曲），记下大概时间。
6. 结束时回到同一页点 **停止并保存报告**（选了时长的会自动结束；退出 Studio 也会保存）。页面会显示结论：
   - “没有记录到异常”；
   - “记录到异常，发生时 Studio 都没有在做任何事”；
   - “其中 N 次发生时 Studio 正在发命令、扫描或卡顿” —— 请务必把报告发回。
7. 点 **打开报告文件夹**（`%APPDATA%\HQPlayer Studio\soak-reports`），把 `soak-<时间>.json` 发给开发者，
   再附上 **复制诊断信息** 的内容和你记下的时间。报告里没有曲名、歌手、专辑、文件名、路径、电脑名或用户名，
   只有曲目序号、时长、播放状态、输出格式（例如 DSD512）和时间。

注意：测试期间请不要让电脑睡眠；测试中 Studio 每分钟保存一次报告，即使 Studio 意外退出，已记录的部分也会保留。

### 12. 隐私

- Studio 不上传任何数据。只有你开启的在线歌词 / 封面来源会收到歌名、歌手、专辑名（从不发送路径）。
- 日志、崩溃报告、诊断信息和测试报告都留在这台电脑上，内容已脱敏；是否发给别人由你决定。

---

### 13. Apple Music（实验功能）

Apple Music 订阅曲目有版权保护，HQPlayer 不能把它们当文件打开。Studio 走的是另一条路：Apple Music 应用照常播放，
声音经一块“虚拟声卡”进入 HQPlayer 的实时输入，由 HQPlayer 升频后送到 DAC。这个功能还没有在 HQPlayer 6 上验证过。

准备（只需一次）：安装一块虚拟声卡（例如 VB-Audio 的 Hi-Fi Cable / VB-CABLE）；在 Windows 音量合成器里把 Apple Music
的输出设为它（格式 24 位 / 44100 Hz，音量 100%）；在 Windows 隐私设置里允许桌面应用使用麦克风；
在 HQPlayer → Settings → Input 里选这块虚拟声卡。页面上的 **连接向导** 会一步一步带你完成：每一步都有具体操作和对应的
Windows 设置按钮，回到 Studio 时自动重新检查，完成的步骤自动打勾；Studio 看不到的步骤点“我已完成这一步”。
输出采样率：HQPlayer 设为“自动 / Auto”时实时输入有时启动不了。开启 DSP 开关后，Studio 会在“开始”时自动改用固定采样率，
“停止”后改回“自动”（向导第 8 步的开关，默认开启）。

使用：侧栏 **Apple Music** → 打开开关 → 按连接向导完成各步 →
在 Apple Music 应用里放一首歌 → 回到 Studio 点 **开始**。第一次请先把放大器音量调低。
之后 Studio 会显示 Apple Music 的曲名、歌手、专辑和封面，播放 / 暂停 / 上一首 / 下一首会转给 Apple Music 应用。
点“停止并回到音乐库”或直接播放音乐库里的内容即可结束，原来的队列会放回 HQPlayer（不自动播放）。

如果“开始”不成功，页面上的“上一次开始”会列出 HQPlayer 对每个地址的回答；点“复制给开发者”发回即可（不含曲名和路径）。
检查结果里的“实时输入地址”一行可以填写 HQPlayer 需要的地址（例如 `audio:default/48000/2`，采样率与虚拟声卡一致），
Studio 下次“开始”会先试它。

歌词与队列：歌词按曲名和歌手从“设置 → 歌词”里已打开的在线来源查找（Apple Music 自己的歌词读不到），只保存在内存里；
校准和手动匹配与音乐库曲目一样。队列面板显示“开始”之后播放过的歌曲——Apple Music 自己的“待播清单”无法从应用外读取。

限制：不是逐位精确（Apple Music 的 Windows 应用不会按曲目切换采样率）；声音比 Apple Music 应用晚几秒；
选歌、搜索、拖动进度仍在 Apple Music 应用里。Studio 不读取、不保存 Apple Music 的音频。

## English

### 1. Install, update, uninstall

Download from GitHub **Releases** (official versions) or **Actions → Windows build → Artifacts** (test builds):

| File                                        | Use                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `HQPlayerStudio-<version>-setup-x64.exe`    | **Installer (recommended)**: per-user, no admin rights, Start menu + desktop shortcut |
| `HQPlayerStudio-<version>-portable-x64.exe` | Portable: double-click to run, nothing installed                                      |
| `HQPlayerStudio-<version>-win-x64.zip`      | The unpacked app                                                                      |

- The program is not code-signed: if Windows SmartScreen appears, choose **More info → Run anyway**.
- All three share one data folder, `%APPDATA%\HQPlayer Studio` (library index, playlists, settings, backups, logs).
  Switching, updating or uninstalling keeps it.
- **Updating**: install the new version. If it needs to change the database, it first makes a "before update" backup.
- Studio never updates itself and never updates, reinstalls or reconfigures HQPlayer.

### 2. First start: connecting HQPlayer

The first start opens a **setup wizard** (check HQPlayer, add music folders, choose connection and control); every field is
explained in [Getting started](getting-started.md#3-the-setup-wizard-opens-on-the-first-start). Run it again from **Settings → General → Setup wizard**. Setting up by hand:

1. If you skip the wizard, Studio uses the **mock engine** and a fictional demo library; HQPlayer is not touched.
2. **Settings → Playback & engine capabilities → Engine connection**: choose "Real HQPlayer (experimental)", then "Restart now". Studio only talks to
   `127.0.0.1:4321` and starts read-only.
3. To play / pause / skip / load albums from Studio, turn on **Allow Studio to control HQPlayer** on the same page. Only
   commands verified on your HQPlayer are offered.
4. Optional: **HQPlayer program** — start HQPlayer with Studio, and show / minimize / hide its window.
5. After a lost connection Studio reconnects and only reads the state again: it never starts playback or changes volume or DSP by itself.

### 3. Library

- **Settings → Library → Add folder**, then "Scan". Local disks, USB drives and network shares work.
- Studio then watches the folders and rescans only what changed, plus a daily fallback scan. Scans slow down while music plays.
- Scans only read. Missing files are marked unavailable, never deleted; tracks used by a playlist are never deleted.
- Covers come from the album folder and the files first; online covers are opt-in (**Settings → Library → Covers**).

### 4. Playing, queue, playlists

- Playing an album, playlist or track stops HQPlayer, loads the tracks into HQPlayer's playlist and starts playback.
- The queue is separate from saved playlists. If someone changes tracks in HQPlayer's own window, Studio shows "out of sync"
  and lets you choose **Follow HQPlayer** or **Replace HQPlayer's queue** (no autoplay). Nothing is overwritten silently.

### 5. Mini Player, media keys, tray, lyrics

- The Mini Player (always on top optional, remembers its place). **Settings → General → Desktop integration**: media keys, tray icon, close to tray.
- Lyrics: local files and embedded lyrics first; online sources (LRCLIB, NetEase, Kugou, lyrics.ovh) are off until you enable
  them one by one in **Settings → Lyrics**, and then only the playing track is looked up.

### 6. Phone / tablet remote

**Settings → Web Remote**: enable LAN access on your home network, open the shown address on the phone (or scan the QR code)
and type the 6-digit pairing code. Devices can be unpaired at any time. Phones never get settings, diagnostics, folder management or paths.

**Works on the PC but not on the phone?** Some Wi-Fi cards (e.g. MediaTek MT7902) stop answering "who has this address?" while
power saving, so the phone cannot find the PC. Studio regularly sends paired phones (and, while a pairing code is shown, the
home network) one empty packet so they remember where the PC is. The real fix: Device Manager → Network adapters → your Wi-Fi
card → Properties: on Power Management untick "Allow the computer to turn off this device", on Advanced set ARP Offload /
NS Offload / Packet Coalescing to Disabled — or connect the PC with a cable.

### 7. DSP settings

With control allowed, turn on "Allow Studio to change HQPlayer DSP settings" in **Settings → DSP** to change mode, 1x / Nx
filters, modulator / noise shaping, output rate, invert and adaptive volume. Every change is read back from HQPlayer. Output
device, buffers, convolution, matrix and CUDA stay in HQPlayer's own settings.

**Presets**: "Save current settings as preset…" stores mode, filters, modulator, rate, invert and adaptive volume under a name;
"Apply" switches them in one go. If HQPlayer no longer offers an item of the preset, Studio names it and changes nothing.

**Equalizer (Settings → EQ)**: HQPlayer has no EQ commands, so Studio writes your curve as a filter file (a WAV impulse
response) that HQPlayer's own convolution engine plays through. One-time setup: click Apply once, then in HQPlayer's
convolution settings choose the file shown on the page for the left and right channel (gain 0 dB) and tick convolution.
After that, edit bands (peak, shelves, low / high-pass), load a preset or paste an AutoEQ ParametricEQ.txt and click Apply.
Boosts automatically lower the preamp so the curve never exceeds 0 dB. With the DSP switch on, Studio can also switch
HQPlayer's convolution and turns it off and on when applying so HQPlayer loads the new curve. The listening check confirms
this with a test filter that only makes music quieter; your EQ goes back after you answer (or after 2 minutes).

### 8. Backups and restore

**Settings → General → Data backups**

- A backup holds the library index, playlists, queue and Studio's settings (not music files or the cover cache). Backups stay in
  `%APPDATA%\HQPlayer Studio\data\backups`.
- Automatic: one **before** every update that changes the database, one a day (waits for a pause in playback, at most a day).
  Kept: 7 daily, 5 before-update, 10 manual, 5 data-before-restore.
- **Back up now** makes one immediately. **Restore…** restarts Studio with the chosen backup; the current data is kept as a
  "data before restore" backup first, so a restore can be undone. HQPlayer is not affected.

**HQPlayer settings backups (Settings → Playback)**

- Studio copies HQPlayer's settings file (`%LOCALAPPDATA%\HQPlayer\settings.xml`: output device, buffer, input, volume, DSP,
  convolution / matrix …) every time it changes, into `%APPDATA%\HQPlayer Studio\hqplayer-settings-backups`. Backing up only reads.
- If HQPlayer ever comes back with blank default settings, a banner on every page offers Restore; any copy in the list can be restored.
- Restore closes HQPlayer the normal way (music stops), keeps the current settings as a copy, writes the chosen copy and starts
  HQPlayer again. If HQPlayer does not quit, nothing is changed — close it yourself and click Restore again.
- Pin a copy to keep it forever (otherwise the newest 30 and the most complete one are kept).

### 9. Going back to an older version

1. Quit Studio and install (or run) the older version.
2. If the newer version changed the database, the older one (0.5.0 or later) says **"This database is from a newer version of
   HQPlayer Studio"**, leaves it untouched and offers **Restore this backup** — the backup the newer version made right before
   it upgraded. The newer database is kept as a backup, so it can be restored after updating again.
3. Changes made after the update (new playlists etc.) are not in the before-update backup.
4. 0.5.0 does not change the database structure, so going from 0.5.0 back to 0.4.x just works; 0.4.x and older do not have this protection.

### 10. Logs, crash reports, diagnostics

- Log: `%APPDATA%\HQPlayer Studio\logs\studio.log` (rotates at 2 MB, 5 files kept) and crash reports `crash-*.txt`. Paths, file
  names, track / artist / album names, the computer name, the user name and LAN addresses are removed before anything is written.
  Nothing is uploaded.
- An unclean end of the previous run (crash, forced quit, power loss) is recorded and shown in **Settings → Diagnostics → Logs and crash reports**.
  A crashed window is reloaded automatically (at most 3 times in 10 minutes).
- For a problem: **Settings → Diagnostics → Copy diagnostics** and send it. It includes the connection state, the recent (redacted)
  conversation with HQPlayer, recent warnings and errors, database / backup state and the long-listening-test result. "Open log folder" for `studio.log` and `crash-*.txt`.

### 11. Long listening test (does Studio affect playback?)

The test only listens in: gaps in HQPlayer's status, playback stopping or skipping without a Studio command, problems while the
library is scanned, and Studio's own stalls. It sends nothing to HQPlayer and changes no setting.

1. Connect Studio to the real HQPlayer and allow control (**Settings → Playback & engine capabilities**).
2. **Settings → Diagnostics → Long listening test**: choose a duration (e.g. 8 hours, or until stopped) and **Start test**.
3. Play albums or playlists from Studio and listen as usual (ideally with your usual DSD512 settings); use Studio and the phone remote normally.
4. At least once during the test: copy a new album into a music folder (folder-watch rescan) **and** press "Scan" in **Settings → Library**.
5. Note the time of anything you hear (clicks, dropouts, stops, skips).
6. **Stop and save report** (a chosen duration ends by itself; quitting Studio also saves). The page shows the verdict.
7. **Open report folder** (`%APPDATA%\HQPlayer Studio\soak-reports`) and send `soak-<time>.json`, the **Copy diagnostics** text
   and your notes. The report contains no titles, artists, albums, file names, paths, computer or user names — only track numbers,
   durations, states, output formats (e.g. DSD512) and timings.

Keep the PC from sleeping during the test. The report is saved every minute, so an unexpected exit keeps what was recorded.

### 12. Privacy

Studio uploads nothing. Only online lyrics / cover sources you enable receive track or album names (never paths). Logs, crash
reports, diagnostics and test reports stay on this computer, redacted; sending them is your choice.

### 13. Apple Music (experimental)

Apple Music's subscription tracks are copy-protected, so HQPlayer cannot open them as files. Studio uses another route: the
Apple Music app plays as usual, its sound goes through a "virtual audio cable" into HQPlayer's live input, and HQPlayer
upsamples it for the DAC. This has not been verified on HQPlayer 6 yet.

Prepare once: install a virtual audio cable (for example VB-Audio's Hi-Fi Cable / VB-CABLE); in the Windows volume mixer send
Apple Music to it (24 bit / 44100 Hz, volume 100 %); in Windows privacy settings allow desktop apps to use the microphone;
in HQPlayer → Settings → Input choose the cable. The page's **Connection guide** walks you through it step by step: each step says
what to do and opens the right Windows page, everything is checked again when you come back to Studio and finished steps tick
themselves; steps Studio cannot see are confirmed with "I've done this". Output rate: on "Auto" HQPlayer sometimes does not
start a live input. With the DSP switch on, Studio switches to a fixed rate on Start and back to Auto on Stop (the switch in
step 8, on by default).

Use: sidebar **Apple Music** → turn the switch on → finish the guide's steps → start a song in the Apple Music app → back in Studio press **Start**. Turn the amplifier down the first time.
Studio then shows Apple Music's title, artist, album and cover, and play / pause / previous / next go to the Apple Music app.
"Stop and return to the library", or simply playing something from the library, ends it; your queue is put back in HQPlayer
(not playing).

If Start does not work, "Last start" lists what HQPlayer answered for each address; "Copy for the developer" gives a summary
without titles or paths. The set-up check's "Live input address" line takes the address HQPlayer needs (e.g.
`audio:default/48000/2`, with the cable's rate); Studio tries it first on the next Start.

Lyrics and queue: lyrics are looked up by title and artist in the online sources you enabled under Settings → Lyrics (Apple
Music's own lyrics cannot be read) and are kept in memory only; calibration and manual matching work as for library tracks.
The queue panel lists the songs played since Start — Apple Music's own Playing Next list cannot be read from outside the app.

Limits: not bit-perfect (the Windows app does not switch sample rate per track); the sound is a few seconds behind the Apple
Music app; choosing music, search and seeking stay in the Apple Music app. Studio never reads or stores Apple Music's audio.
