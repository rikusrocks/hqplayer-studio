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

Not affiliated with Signalyst. HQPlayer is a product of Signalyst.
