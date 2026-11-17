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

Not affiliated with Signalyst. HQPlayer is a product of Signalyst.
