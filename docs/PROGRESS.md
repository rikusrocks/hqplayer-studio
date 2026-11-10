# PROGRESS

## 2026-11-10 — Phase 0 交付（Mock 原型 + 只读探测器）

```text
Implemented:
- pnpm 12 monorepo（TypeScript 6 strict、ESLint、Prettier、Vitest），10 个包/应用，见 README。
- contracts：全部 DTO / 请求 / WebSocket 事件的 zod 模式；能力等级 confirmed/observed/untested/unsupported/simulated。
- hqplayer-adapter：
  - MockHQPlayerAdapter（播放/暂停/切歌/seek/音量/队列/断线/外部改动/ACK 超时模拟；PCM/DSD 伪状态 → DSD512）。
  - 基于官方 SDK 6.0.1 源码（MIT）的协议层：XML 解析/序列化、按行分帧（半包/粘包/跨读 UTF-8）、
    命令注册表（71 条 SDK 命令按副作用分级）、HqpConnection（单飞串行、超时不重试、默认只读、拒绝非 SDK 命令）。
  - LiveHQPlayerAdapter（实验性）：只读路径可用；写命令按能力矩阵门控，默认零引擎流量。
- library：node:sqlite + WAL + 迁移；音乐库/播放列表/队列快照/设置仓库；扫描器（增量、离线≠删除、
  单文件错误隔离、文件名/目录兜底、CD1/CD2、封面：目录图优先、内嵌次之）；CJK 搜索归一化；
  WAV 标签乱码修复；13 张虚构演示专辑 + 2 个演示播放列表（含刻意重复曲目）；生成式 SVG 封面。
- core：Fastify REST（/api/v1 全套草案端点）+ WS 事件；EngineService（串行、超时、重连不自动播放）；
  QueueService（先引擎后提交、同步检测、Take over、Play Now/Next/Add to Queue 区分、播放列表不受影响）；
  扫描任务；安全钩子（仅本机、Host/Origin 校验、JSON-only、WS 拒绝时关闭套接字、CSP）。
- desktop：Electron 主进程内托管 Core，沙箱 preload 仅暴露 studioShell；迷你播放器窗口（置顶、
  多显示器位置校验）；导航/权限锁定；--smoke-test 模式。桌面 UI：首页/专辑/歌手/歌曲/文件夹/
  播放列表/设置（常规、音乐库、播放与引擎能力、DSP、网页遥控、诊断）、右侧正在播放/队列、底部播放条、快捷键、中英文。
- remote：移动优先网页遥控（正在播放/浏览/播放列表/队列），PWA manifest，离线提示。
- lyrics：LRC 解析与当前行定位（多时间戳、offset、逐字标签）。
- hqp-probe：Gate A/B 只读探测，默认脱敏 JSON 报告；Node SEA 单文件可执行；Windows 使用说明。
- CI：ci.yml（ubuntu + windows：lint/typecheck/test/build）；windows-build.yml（Electron portable+zip、
  打包后冒烟测试、probe.exe 冒烟测试、上传 artifacts；打 v* 标签时生成草稿 Release）。
- 文档：protocol-capabilities、architecture、decision-log、test-matrix、交接书公开副本、第三方声明。

Verified (Mac, Node 26.11.1, 2026-11-10):
- pnpm lint ✔ · pnpm typecheck ✔（10 个项目）· pnpm test ✔ 13 files / 110 tests · pnpm build ✔
- Electron 45.2.3 `--smoke-test`：SMOKE_OK（preload 桥存在、渲染进程无 Node、Core 健康、Electron 内 SQLite 3.53.4、/remote/ 可用）。
- electron-builder macOS `--dir` 打包后从 app.asar 运行：SMOKE_OK；asar 内只有 dist/（无 node_modules、无原生模块）。
- hqp-probe SEA 可执行文件：无 HQPlayer 时输出 ECONNREFUSED 说明并写出报告（exit 0）。
- 浏览器实测（真实 Core + Mock）：桌面 1440×900 从第 3 首播放专辑 → 播放条显示引擎回报的 DSD64 → DSD512；
  手机 375×812 遥控页同步显示；在手机端“全部播放”播放列表 → 桌面队列 1 秒内切换；模拟断线 → 红色状态、
  传输禁用、队列“引擎离线”；重连 → 恢复且未自动播放；两个页面控制台均无错误。
- `pnpm dev` 三个服务（Core 47321、桌面 5173、遥控 5174）均可用，代理 REST + WS 正常。

Known limitations:
- 未接触真实 HQPlayer：所有 Desktop 6 能力均为 untested（Album Mode 切换为 unsupported：SDK 无此命令）。
- Windows CI 尚未在 GitHub 上跑过第一次（首推后核对；Windows 路径相关测试首次在 Windows 运行）。
- Core 只监听 127.0.0.1；手机遥控需 Phase 3 配对后才能在局域网使用。
- 服务端返回的同步原因/通知文本目前是英文（界面其他文字已中英双语）。
- 无文件监听（需手动“扫描”）；移动文件会成为新曲目（旧条目标记不可用）；无 FTS5（大库搜索待优化）。
- 未签名的 exe 会触发 SmartScreen；应用图标为 Electron 默认图标。
- 歌词仅有解析器，无 UI/LRCLIB（Phase 4）；无托盘/媒体键（Phase 4）。

Next:
- 首次推送后核对 CI（ubuntu/windows）与 Windows artifacts，修正 Windows 专有问题。
- Phase 1：根据探测报告填写能力矩阵 → Live adapter 只读接入（真实状态显示）→ 经同意的 Gate C 写命令测试。
- Phase 2：真实音乐目录扫描（文件监听、移动检测、FTS5、Shift-JIS/GBK 标签）。

Windows action needed:
1. 等 GitHub Actions 的 “Windows build” 运行成功后，下载 artifact `hqp-probe-windows-x64`，解压。
2. 在装有 HQPlayer Desktop 6 的电脑上先打开 HQPlayer，再双击 hqp-probe.exe（SmartScreen：更多信息 → 仍要运行）。
3. 约 10 秒后按回车关闭；把同目录生成的 hqp-probe-report-*.json 发回（已脱敏）。
4. （可选）下载 `HQPlayerStudio-windows-x64`，运行 portable exe，确认界面能打开（Mock 模式，不会碰 HQPlayer）。
```

## Phase 状态

| Phase                         | 状态                                       | 退出条件                                                                                   |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 0 仓库 + 风险隔离             | ✅ 本地完成；⏳ 等首个 CI/Windows artifact | Mac 上 install/dev/test/build ✔；Mock 播放/暂停/换歌/断线 ✔；CI 产出 Windows 包与探测器 ⏳ |
| 1 Desktop 6 API Spike         | ⏳ 等探测报告                              | 稳定读取真实状态；传输/装载结果有实测记录                                                  |
| 2 持久音乐库 + 播放列表       | 部分（数据层与扫描器已就绪）               | 真实目录、重启不丢、CJK 路径、实际选专辑播放                                               |
| 3 同步网页遥控                | 部分（本机已同步）                         | 局域网配对、断线恢复                                                                       |
| 4 迷你播放器 / 歌词 / 设置 UX | 部分（迷你窗、设置分层）                   | 歌词、托盘/媒体键                                                                          |
| 5 稳定性与发布                | 未开始                                     | 长时间 DSD512、备份/回滚、签名与声明                                                       |
