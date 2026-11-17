HQPlayer Studio — hqp-probe (read-only HQPlayer API diagnostic)
================================================================

中文
----
1. 在安装了 HQPlayer Desktop 6 的 Windows 电脑上，先打开 HQPlayer（正常播放或空闲都可以）。
2. 双击 hqp-probe.exe。
   - 若出现 “Windows 已保护你的电脑”（未签名程序），点 “更多信息” → “仍要运行”。
3. 程序只连接本机 127.0.0.1:4321，只发送官方 SDK 6.0.1 中的“只读查询”命令。
   它不会改变播放、播放列表、音量、DSP、配置或许可证。
4. 完成后，同一文件夹会生成 hqp-probe-report-日期时间.json。
   把这个 JSON 文件发回给开发者即可。曲名、路径、播放列表名、实例名和许可证信息已脱敏。
5. 运行大约 10 秒。按回车键关闭窗口。

可选参数（一般不需要）：
  hqp-probe.exe --port 4321 --timeout 3000 --out C:\某个文件夹
  hqp-probe.exe --include-raw   另存一份【未脱敏】原始记录，仅供自己排查，请勿公开分享。

English
-------
1. On the Windows PC with HQPlayer Desktop 6, start HQPlayer first (playing or idle).
2. Double-click hqp-probe.exe. If SmartScreen warns (unsigned app): "More info" -> "Run anyway".
3. It connects only to 127.0.0.1:4321 and sends only side-effect-free commands documented in
   the official HQPlayer SDK 6.0.1. It never changes playback, the playlist, volume, DSP,
   configuration or the licence.
4. A file named hqp-probe-report-<date>-<time>.json is written next to the .exe.
   Send that JSON back. Titles, paths, playlist names, the instance name and licence data are
   redacted.
5. Takes about 10 seconds. Press Enter to close the window.

hqp-gatec.exe — Gate C 写命令测试 / write-command test
=====================================================

这是第二个工具，会真的控制 HQPlayer（播放、暂停、跳转、临时替换播放列表），
只执行已批准的计划（docs/gate-c-plan.md），每一步都要你按回车。约 20 分钟，需要你在场听。

准备：
- 测试文件夹，例如 D:\HQPS 测试\テスト アルバム\ ：同一专辑连续 3 首 FLAC（最好无缝专辑）+ 1 个 DSF（可选）。
  文件夹里最多 40 个音频文件，避免误选整个音乐库。
- 放大器音量适中；HQPlayer 打开即可。

运行：双击 hqp-gatec.exe → 先自动备份当前播放列表（.m3u8 + .json，留在本机）→ 输入 y 开始 →
每一步：回车执行 / s 跳过 / q 中止并恢复 → 结束时自动恢复原播放列表（不自动播放）并核对。
把 hqp-gatec-report-*.json 发回即可（已脱敏）。备份文件不要发。
若提示“没有完全恢复”，在 HQPlayer 里打开 hqp-gatec-backup-*.m3u8 即可还原。
不会发送任何 DSP、输出、配置命令；音量只会设为当前值，不会调大。

hqp-gatec.exe actually controls HQPlayer (play, pause, seek, temporarily replace the playlist), only
as approved in docs/gate-c-plan.md, one step at a time (Enter each), ~20 minutes with you listening.
It backs up the playlist first (.m3u8 + .json, keep local) and restores it at the end. Send back
only hqp-gatec-report-*.json. If restore is incomplete, open the backup .m3u8 in HQPlayer.

hqp-dspgate.exe — DSP 设置测试 / DSP settings test
==================================================

第三个工具，用来弄清 Studio 以后怎样安全地切换 模式 / 滤波器 / 调制器 / 采样率。
它会临时更改这些设置：每一步都要你按回车，改完马上改回，最后再整体核对一遍。约 10 分钟，需要你在场听。

它会做的：
- D1 调制器、D2/D3 滤波器（Nx+1x、单个值）、D4 采样率（只调低、同一系列）、D5 模式（并重读各列表）、
  D6 反相/卷积/自适应音量开关、D7 矩阵配置（有两个以上配置且当前已选中时才做）——都在停止状态下进行，不出声。
- D8 播放当前播放列表，在播放中切换一次调制器、一次滤波器，问你听到了什么，然后停止。
它不会做的：不改播放列表、音量、输出设备、配置文件；不发送 HQPlayer 没有列出的选项；不调高采样率。

准备：HQPlayer 打开，播放列表里有能正常播放的曲目，放大器音量适中。
运行：双击 hqp-dspgate.exe → 先把当前设置写到 hqp-dspgate-original-*.txt → 可为调制器和滤波器各选一个
“你的电脑能流畅播放”的测试项（直接回车用默认）→ 输入 y 开始 → 每一步：回车执行 / s 跳过 / q 中止并恢复。
如果开始时 HQPlayer 正在播放，工具会先问你是否停止；结束后不会自动恢复播放。
结束时把 hqp-dspgate-report-*.json 发回（不含曲名、路径、矩阵配置名）。
若提示“没有完全恢复”，按屏幕上（或 hqp-dspgate-original-*.txt 里）列出的原设置在 HQPlayer 主窗口改回即可。

hqp-dspgate.exe finds out how HQPlayer's mode / filter / shaper / rate commands behave so Studio can
offer them safely later. It briefly changes those settings, one step at a time (Enter each), reverts
each change straight away and compares everything with the starting snapshot at the end. About
10 minutes with you listening. Steps D1-D7 run while stopped (silent); D8 plays the current playlist
and changes the shaper and the filter once each during playback. It never touches the playlist,
volume, output device or configuration, only sends options HQPlayer itself lists, and only lowers
the rate. If HQPlayer is playing at the start it asks before stopping, and it does not resume.
Send back hqp-dspgate-report-*.json. If it says "Not fully restored", set the values shown on
screen (also saved in hqp-dspgate-original-*.txt) again in HQPlayer's main window.

hqp-livegate.exe — 实时输入测试 / live-input test
=================================================

第四个工具，用来弄清：HQPlayer 能不能把“实时输入”升频播放——例如 Apple Music 的声音经一块
虚拟声卡送进 HQPlayer。Apple Music 订阅曲目有版权保护，HQPlayer 不能当文件打开，只能走这条路。
约 10 分钟，需要你在场听。

准备（都在这台 Windows 电脑上，工具不会替你做）：
1. 安装一块虚拟声卡（论坛用户常用 VB-Audio 的 Hi-Fi Cable 或 VB-CABLE）。
2. Windows 设置 → 系统 → 声音：把 Apple Music 的输出设备设为这块虚拟声卡的“播放”端（或设为默认输出）。
   在该设备的属性里把格式设成 24 位 / 44100 Hz（CD 规格曲目的采样率）；
   音量 100%，关闭“音频增强”。
3. Windows 设置 → 隐私和安全性 → 麦克风：打开“允许桌面应用访问麦克风”，否则 HQPlayer 读不到任何输入设备。
4. HQPlayer → Settings → Input：选择这块虚拟声卡的“录制”端。
5. 在 Apple Music 里开始播放一首歌，并让它一直播放。此时音箱没有声音是正常的。
6. 放大器音量先调低：实时输入可能出现突发噪声。

它会做的：
- 只读：读取 HQPlayer 列出的输入（GetInputs / GetTransport）；备份当前播放列表（.m3u8 + .json，留在本机）。
- W1 只读：看 Windows 能否看到 Apple Music 正在播放的曲名、歌手、专辑和封面（屏幕上显示，问你对不对）。
- L1 停止 HQPlayer 当前播放。
- L2 清空播放列表，加入一个实时输入条目（依次尝试 HQPlayer 列出的、audio:default/0/2、
  audio:default/44100/2、audio:default/48000/2），并播放。
- L3 听 15 秒：有没有声音、干不干净、音调速度对不对。
- W2 通过 Windows 让 Apple Music 暂停约 8 秒再继续（看 Studio 以后能否遥控它）。
- L4 连续听 60 秒看稳不稳。  L5 停止再播放一次。
- L6 恢复原播放列表并核对（不自动播放）。
它不会做的：不改 DSP、音量、输出设备、输入设备、配置；不发送 SetTransport 之类的设置命令；
不读取、不保存 Apple Music 的任何音频。

运行：双击 hqp-livegate.exe → 输入 y 开始 → 每一步：回车执行 / s 跳过 / q 中止并恢复。
结束时把 hqp-livegate-report-*.json 发回（不含曲名、歌手、专辑、路径）。备份文件不要发。
若提示“没有完全恢复”，在 HQPlayer 里打开 hqp-livegate-backup-*.m3u8 即可还原。
可选：hqp-livegate.exe --uri audio:某个输入   先尝试你指定的实时输入地址。

hqp-livegate.exe finds out whether HQPlayer can upsample a live input - for example Apple Music
played into a virtual audio cable. Subscription tracks are copy-protected, so HQPlayer cannot open
them as files; this is the only route. About 10 minutes with you listening.

Prepare (on this PC; the tool does none of this for you): 1. install a virtual audio cable (forum
users report VB-Audio Hi-Fi Cable or VB-CABLE); 2. in Windows Sound settings send Apple Music to
the cable's playback side, set that device to 24 bit / 44100 Hz, volume 100 %, enhancements off;
3. Windows Settings -> Privacy & security -> Microphone: allow desktop apps, or HQPlayer sees no
input device; 4. HQPlayer -> Settings -> Input: choose the cable's recording side; 5. start a song
in Apple Music and leave it playing (silence from the speakers is expected at this point);
6. turn the amplifier DOWN first - a live input can produce a burst of noise.

Steps: read-only look at HQPlayer's inputs and a local playlist backup; W1 (read-only) what
Windows knows about the song Apple Music is playing; L1 stop; L2 clear the playlist, add ONE
live-input entry (what HQPlayer lists, then audio:default/0/2, /44100/2, /48000/2) and play it;
L3 listen 15 s; W2 pause Apple Music through Windows for ~8 s and resume; L4 listen 60 s;
L5 stop and play again; L6 restore the original playlist (not playing). It never touches DSP,
volume, the output or input device or the configuration, never sends SetTransport-style
commands, and never reads or stores any Apple Music audio. Send back hqp-livegate-report-*.json
(no titles, artists, albums or paths). If it says "not fully restored", open
hqp-livegate-backup-*.m3u8 in HQPlayer.

Not affiliated with Signalyst. HQPlayer is a product of Signalyst.
