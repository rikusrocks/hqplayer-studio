HQPlayer Studio {{VERSION}} — a third-party music library, playlist manager and web remote for HQPlayer Desktop 6. **Not affiliated with Signalyst.**

### 下载哪个文件 / Which file to download

| 文件 / File                                   | 说明                                                                               | Notes                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `HQPlayerStudio-{{VERSION}}-setup-x64.exe`    | 安装版（推荐）：开始菜单 / 桌面快捷方式，可在“设置 → 应用”里卸载；不需要管理员权限 | Installer (recommended): Start menu / desktop shortcut, uninstall from Settings → Apps; no admin rights needed |
| `HQPlayerStudio-{{VERSION}}-portable-x64.exe` | 免安装版：双击即可运行                                                             | Portable: double-click to run, nothing installed                                                               |
| `HQPlayerStudio-{{VERSION}}-win-x64.zip`      | 解压即用的程序文件夹                                                               | The unpacked app as a zip                                                                                      |
| `hqp-probe-{{VERSION}}-windows-x64.zip`       | HQPlayer 接口检测工具（只在开发者要求时使用）                                      | HQPlayer API test tools (only when the developer asks)                                                         |
| `SHA256SUMS.txt`                              | 文件校验值                                                                         | Checksums                                                                                                      |

三种方式共用同一个数据文件夹（`%APPDATA%\HQPlayer Studio`）：换用另一种、升级或卸载都不会丢失音乐库、播放列表和设置。升级会自动先备份数据库；退回旧版本的方法见用户指南。

All three share one data folder (`%APPDATA%\HQPlayer Studio`): switching, updating or uninstalling keeps the library, playlists and settings. Updates back up the database first; see the user guide for going back to an older version.

- 安装与上手 / Getting started: [docs/getting-started.md](https://github.com/rikusrocks/hqplayer-studio/blob/v{{VERSION}}/docs/getting-started.md)（第一次打开时有设置向导 / a setup wizard opens on the first start）
- 用户指南 / User guide: [docs/user-guide.md](https://github.com/rikusrocks/hqplayer-studio/blob/v{{VERSION}}/docs/user-guide.md)
- 更新内容 / Changes: [docs/PROGRESS.md](https://github.com/rikusrocks/hqplayer-studio/blob/v{{VERSION}}/docs/PROGRESS.md)

程序没有数字签名，第一次运行时 Windows SmartScreen 可能提示“已保护你的电脑”：点“更多信息 → 仍要运行”。Studio 不会修改 HQPlayer 的安装、许可证或 DSP / 输出设置，除非你在 Studio 里明确开启相应开关；只有在你点“恢复 HQPlayer 设置”时，它才会把之前备份的 HQPlayer 设置文件写回去。它不会上传任何数据。

The program is not code-signed; on first start Windows SmartScreen may say "Windows protected your PC": choose "More info → Run anyway". Studio never changes HQPlayer's installation, licence or DSP / output settings unless you turn on the matching switch in Studio; it writes HQPlayer's settings file only when you click "Restore" on a backup of it. It uploads nothing.
