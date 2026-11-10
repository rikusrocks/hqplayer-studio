# PROGRESS

## 2026-11-10 — Phase 1 第一步：真机只读探测 + 只读真实模式

```text
Implemented:
- 根据用户 hqp-probe 报告（HQPlayer Desktop 6，engine 6.1.0，Windows）更新能力矩阵：
  connect / status.read / volume.read / queue.read / dsp.read → confirmed；status.subscribe、library.native → observed；
  所有写命令仍为 untested 并禁用；mode.album 仍为 unsupported。
- Live adapter 按真机行为修正：1 基索引转换；不再把 Status.tracks_total 当作播放列表长度（真机为 0，实际 52 首）；
  停止时从 PlaylistGet 补全当前曲目；序号变化时只读重读播放列表；连接时读取 VolumeRange。
- 引擎曲目 → 音乐库匹配：支持真机的 “file:” + 原始 Windows 路径形式（不 URI 解码）及标准 file URI。
- 设置 → 播放与引擎能力：可选 “Mock 引擎” / “真实 HQPlayer（只读，实验）”，保存后一键重启生效
  （优先级：启动参数 > 保存的选择 > Mock；portable 版重启原始 exe）。
- 设置 → 诊断：只读显示 HQPlayer 当前播放列表（不暴露文件路径），并标出已在音乐库中的曲目。
- 探测器 v0.1.1：数值属性不再脱敏（v0.1.0 隐藏了 album 模式标志），记录 file: 前缀确切形式。

Verified (Mac, 2026-11-10):
- 新增/更新测试全部通过（见 test-matrix）；Live adapter 测试使用与真机报告同结构的合成响应。
- 端到端彩排：本机临时假 HQPlayer（按真机报告的属性结构、演示库路径）+ Core（STUDIO_ADAPTER=live）+ 浏览器：
  显示 “停止 · 第 2 首 Velvet Steps · DSD512 (48k) · sinc-Mx · ASDM7EC-super 512+fs · −6.0 dB”；
  诊断页读出 3 首、专辑模式、均匹配到音乐库；点“播放”在本地被拒绝（capability_unavailable），无引擎流量。

Known limitations:
- 只观察过停止状态：播放中的进度单位、Status 的 track 索引基数、<metadata> 是否给出 uri、推送频率仍待确认。
- 写命令（播放/队列/音量/DSP）全部禁用，等待 Gate C 授权。
- 真实模式下音乐库仍是演示数据（真实目录扫描为 Phase 2），因此 HQPlayer 播放的曲目通常不会匹配到音乐库。

Next:
- 用户在 Windows 上：① 用 v0.1.1 探测器在“正在播放”时再跑一次；② 在 Studio 中切换到“真实 HQPlayer（只读）”验证显示。
- Gate C（需用户明确同意 + 指定小测试专辑）：先只读备份 HQPlayer 当前播放列表，再逐项验证 加载/播放/暂停/seek/下一首、
  中文路径、PCM + DSF、两首连播。
- Phase 2：扫描真实音乐目录。

Windows action needed:
1. 从最新成功的 “Windows build” 下载 hqp-probe-windows-x64，在 HQPlayer **正在播放**时运行，发回新的 JSON。
2. 下载 HQPlayerStudio-windows-x64，打开后：设置 → 播放与引擎能力 → 选择“真实 HQPlayer（只读，实验）” → 立即重启；
   看播放条与 设置 → 诊断 → “HQPlayer 当前播放列表（只读）” 是否与 HQPlayer 一致。
```

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
- GitHub Actions（rikusrocks/hqplayer-studio）：CI 在 ubuntu-latest 与 windows-latest 上 format/lint/typecheck/test/build 全部通过；
  Windows build：测试 → 打包 portable+zip → 打包后的 HQPlayer Studio.exe 冒烟测试 SMOKE_OK（Windows 上 Electron 内 SQLite 3.53.4）
  → hqp-probe.exe 冒烟测试写出报告 → 上传 artifacts（HQPlayerStudio-windows-x64 ≈252 MB、hqp-probe-windows-x64 ≈38 MB，保留至 2026-12-10）。
  首次推送暴露的两个 CI 问题已修复：Windows 检出为 CRLF（加 .gitattributes 固定 LF）；两处固定毫秒等待的测试在慢机器上不稳定（改为条件等待）。

Known limitations:
- 未接触真实 HQPlayer：所有 Desktop 6 能力均为 untested（Album Mode 切换为 unsupported：SDK 无此命令）。
- Core 只监听 127.0.0.1；手机遥控需 Phase 3 配对后才能在局域网使用。
- 服务端返回的同步原因/通知文本目前是英文（界面其他文字已中英双语）。
- 无文件监听（需手动“扫描”）；移动文件会成为新曲目（旧条目标记不可用）；无 FTS5（大库搜索待优化）。
- 未签名的 exe 会触发 SmartScreen；应用图标为 Electron 默认图标。
- 歌词仅有解析器，无 UI/LRCLIB（Phase 4）；无托盘/媒体键（Phase 4）。

Next:
- Phase 1：根据探测报告填写能力矩阵 → Live adapter 只读接入（真实状态显示）→ 经同意的 Gate C 写命令测试。
- Phase 2：真实音乐目录扫描（文件监听、移动检测、FTS5、Shift-JIS/GBK 标签）。

Windows action needed:
1. 打开 https://github.com/rikusrocks/hqplayer-studio/actions/workflows/windows-build.yml → 最新成功的运行 → Artifacts，下载 `hqp-probe-windows-x64`，解压。
2. 在装有 HQPlayer Desktop 6 的电脑上先打开 HQPlayer，再双击 hqp-probe.exe（SmartScreen：更多信息 → 仍要运行）。
3. 约 10 秒后按回车关闭；把同目录生成的 hqp-probe-report-*.json 发回（已脱敏）。
4. （可选）下载 `HQPlayerStudio-windows-x64`，运行 portable exe，确认界面能打开（Mock 模式，不会碰 HQPlayer）。
```

## Phase 状态

| Phase                         | 状态                                       | 退出条件                                                                                            |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 0 仓库 + 风险隔离             | ✅ 完成                                    | Mac 上 install/dev/test/build ✔；Mock 播放/暂停/换歌/断线 ✔；CI 产出并冒烟测试 Windows 包与探测器 ✔ |
| 1 Desktop 6 API Spike         | 🔄 只读已在真机验证；等播放中探测与 Gate C | 稳定读取真实状态；传输/装载结果有实测记录                                                           |
| 2 持久音乐库 + 播放列表       | 部分（数据层与扫描器已就绪）               | 真实目录、重启不丢、CJK 路径、实际选专辑播放                                                        |
| 3 同步网页遥控                | 部分（本机已同步）                         | 局域网配对、断线恢复                                                                                |
| 4 迷你播放器 / 歌词 / 设置 UX | 部分（迷你窗、设置分层）                   | 歌词、托盘/媒体键                                                                                   |
| 5 稳定性与发布                | 未开始                                     | 长时间 DSD512、备份/回滚、签名与声明                                                                |
