# PROGRESS

## 2026-11-10 — v0.1.9：由 Studio 启动 HQPlayer，并可隐藏其窗口

```text
Implemented:
- 设置 → 播放与引擎能力 → “HQPlayer 程序”（仅 Windows）：自动找到 HQPlayer Desktop（Windows“已安装的程序”记录，
  或 Program Files\Signalyst），也可手动“选择 HQPlayer…”；“启动 Studio 时自动启动 HQPlayer”；
  “HQPlayer 窗口：正常 / 最小化 / 隐藏（后台运行）”；“启动 / 显示 / 隐藏 HQPlayer”按钮。
  隐藏后 HQPlayer 照常运行与播放，由 Studio 控制；关闭 Studio 后它仍在后台，下次在 Studio 里点“显示”即可。
  Studio 不修改 HQPlayer 的安装或设置，只启动程序并用 Windows 标准窗口调用显示/隐藏窗口。
- 测试修复：桌面端主进程的测试（窗口位置、HQPlayer 程序）之前根本没有运行，现在纳入测试。

Verified:
- 自动化测试通过；Windows CI 上用记事本真实验证“隐藏 → 不可见 → 显示 → 可见”。
- 未在你的电脑上验证：HQPlayer 的安装位置识别、HQPlayer 窗口的隐藏/恢复。

Known limitations:
- 音量：HQPlayer 目前拒绝远程调音量（VolumeRange enabled=0），需要先在 HQPlayer 设置中允许，见 Next。

Next:
- 你：在 Studio 设置里看“HQPlayer 程序”是否自动找到；试“隐藏 / 显示 HQPlayer”和“启动时自动启动”。
- 音量：请把 HQPlayer 设置里与音量相关的部分截图给我（以及是否勾选 Direct SDM）。
```

## 2026-11-10 — v0.1.8：双击播放、移除文件夹、重复导入、同文件夹合并专辑

```text
Implemented:
- 队列：桌面端双击（或回车）播放某首，单击不再打断播放；手机遥控仍是轻点播放。
  播放中跳转：先尝试 HQPlayer 直接切换，2.5 秒内没切换就 Stop → 等真正停止 → 选择 → 播放；诊断信息记录走了哪条路径。
  “上一首”同样处理。
- 设置 → 音乐库：每个文件夹可“移除”（确认后从音乐库删除其歌曲、空专辑/歌手，并从播放列表移除这些歌曲；
  磁盘文件不动）。移除演示音乐库后不会再自动出现。正在扫描该文件夹时会先停止扫描。
- 重复导入：添加已在音乐库中的子文件夹会被拒绝并提示；添加包含已有文件夹的上级文件夹时，自动并入
  （歌曲 ID 不变，播放列表不受影响，下次扫描按新位置重新读取）。
- 同一文件夹里专辑名不一致（中英文、版本后缀等）的曲目：若曲目编号清楚表明是一张专辑（≥80% 有编号、
  同碟无重复编号、编号基本连续、不超过 3 种专辑名），自动归为一张专辑（取曲目最多的专辑名）。
- 修复：自动重扫时新专辑的封面查找（上一版的一处改动未生效，已补测试）。

Verified:
- 自动化测试 170 项通过。新增：跳转两种引擎行为（会切换 / 忽略切换）都播放到正确曲目；移除文件夹的清理与可重新添加；
  子文件夹拒绝、上级文件夹并入后播放列表保留；中英文专辑名同文件夹合并、真正混合的文件夹不合并。

Known limitations:
- 不同文件夹中的同一张专辑（例如备份副本）尚未自动合并或隐藏（见 Next）。
- 联网核对专辑（MusicBrainz）尚未实现：需要你同意把专辑/艺人名发给 MusicBrainz，默认关闭。

Next:
- 音量控制、启动/隐藏 HQPlayer（调研中）。
- 你：试双击播放、移除演示音乐库、同文件夹多语言专辑。
```

## 2026-11-10 — v0.1.7：旧编码中日文标签 + HQPlayer 自行播放曲目的封面（Phase 2 收尾）

```text
Implemented:
- 旧 Windows 标签软件写入的 GBK（简体中文）/ Shift-JIS（日文）标签（ID3v1、ID3v2 的 ISO-8859-1 帧、WAV RIFF INFO）
  自动还原：按字节范围判断（常用汉字 GB2312 区 vs 假名/一级汉字），同一文件的所有字段一起判断，专辑文件夹名作提示；
  拿不准时保持原样；“Café / Motörhead / Sigur Rós”等欧洲文字不会被误改。新扫描或文件变化后生效。
- HQPlayer 自己播放（不是 Studio 队列里的）的曲目只要在音乐库中，播放条和遥控页也显示专辑封面。
- Windows 安装包冒烟测试新增“旧编码解码器可用”检查（Electron 内置 ICU）。

Verified:
- 自动化测试全部通过；样本测试：44/44 中文标题、28/30 日文标题正确还原，其余保持原样，0 误判；
  扫描端到端：GBK / Shift-JIS 写入的 WAV 标签扫描后显示为正确中文/日文。

Known limitations:
- 已扫描过、文件未变化的曲目不会自动重新读取标签：想修复旧乱码请在 设置 → 音乐库 移除再添加该文件夹
  （或等文件变化）。之后可加“重新读取标签”按钮。
- 繁体中文 Big5 暂不自动识别（与 GBK 太难区分），以后可加手动选择。

Next:
- 你：测试 v0.1.6/0.1.7 的清空与换专辑；有乱码标签的专辑可看看是否已正确显示。
- 我：Phase 3（局域网配对，让手机遥控可用）。
```

## 2026-11-10 — v0.1.6：清空仍剩一首的修复 + Phase 2 音乐库自动更新

```text
Implemented:
- 你的 v0.1.5 反馈“清空后总剩一首”：HQPlayer 回复 Stop 时其实还没停下，紧接着的 PlaylistClear 会保留正在播放的
  那首（也删不掉）。Gate C 是等到推送的“已停止”状态后才清空的，所以通过了。现在：Stop → 等待 HQPlayer 报告
  “已停止”（最多 6 秒）→ 清空 → 回读；仍有残留则逐条删除、等 1 秒重试，最多 3 次，仍失败则明确报错。
- 设置 → 诊断 新增“复制诊断信息”：状态 + 最近与 HQPlayer 的通信时间线；路径、曲名、艺人、专辑、电脑名替换为编号。
- Phase 2 音乐库：
  · 自动更新：监听音乐文件夹，有变化（新增/删除/改名/拷入）后只重扫变化的文件夹；无法监听的文件夹（部分 NAS）
    每小时检查一次；正常情况每 12 小时兜底检查一次；启动时不强制全库扫描。设置里显示“自动更新：已开启”。
  · 移动/重命名的文件保留原有身份（播放列表、队列仍指向它），复制不算移动。
  · 扫描提速：语句缓存 + 批量提交（每约 200 个文件一次事务）；数据库开销 4.2 s → 2.3 s / 2 万文件。
  · HQPlayer 播放时扫描自动放慢（每次读取文件前等待 25 ms；未变化的文件只做一次 stat，不受影响）。
  · 自动扫描只为有变化的专辑重新查找封面；手动扫描仍检查全部缺封面的专辑。
  · pnpm bench:scan：合成音乐库基准（2 万文件：首次 7.6 s，未变化重扫 1.1 s，增量 1.6 s，Mac SSD）。

Verified:
- 自动化测试 154 项通过。新增：替身引擎模拟“Stop 回复早于真正停止、播放中的曲目删不掉”——v0.1.5 的逻辑在该测试中
  失败（与你看到的一致），新逻辑通过；诊断信息不含路径/曲名；真实文件夹监听（新增文件夹被自动扫入、
  改名后曲目 ID 不变）、1200 文件增删改移、部分重扫、兜底计划、扫描节流。
- Mac 端到端彩排（替身引擎 Stop 延迟 1.5 s）：播放中换专辑正确；播放中清空 → 约 2 s 后 HQPlayer 列表为空且停止。

Known limitations:
- 播放中清空/换专辑要等 HQPlayer 真正停止（你的机器约 4 s）。
- 文件夹监听在部分网络共享上可能收不到事件 → 显示“无法监听”，改为每小时检查。
- Phase 2 未完成项：Shift-JIS/GBK 旧编码标签、HQPlayer 自己播放的曲目的封面 → 下一版。

Next:
- 你：用 v0.1.6 再试“播放中清空队列”和“播放中换专辑”。如果还剩一首，请在 设置 → 诊断 点“复制诊断信息”发给我。
- 我：Shift-JIS/GBK 标签、HQPlayer 播放曲目的封面，然后 Phase 3（局域网配对）。
```

## 2026-11-10 — v0.1.5：队列同步与“清空不干净”修复（用户反馈）

```text
Implemented:
- 根因（你的反馈 + 替身复现）：HQPlayer 在播放中执行 PlaylistClear 会保留正在播放的那首并继续播放。
  因此“清空队列”留下一首；播放新专辑时列表变成 [旧曲, 新专辑…]，SelectTrack 1 又选中旧曲 → 一直播放同一首；
  “接管”同理，结束后立刻再次不一致，横幅消不掉。Gate C 只在停止状态下清空过，所以没测出来。
- 装载/清空 HQPlayer 播放列表现在：Stop（已验证；已停止时 0 ms）→ PlaylistClear → 回读确认为空
  （残留用已验证的 PlaylistRemove 逐条删除，仍有残留则报错）→ PlaylistAdd → 回读确认条数 → SelectTrack → Play。
- 队列横幅新增“以 HQPlayer 为准”（只读：HQPlayer 播放列表全在音乐库 → 作为 Studio 队列；否则丢弃旧队列，
  显示 HQPlayer 自己的播放列表）；“接管”改名“用 Studio 队列替换 HQPlayer”，并先确认（会停止播放）。
- 启动时：上次保存的队列若与 HQPlayer 正在播放的不一致，自动以 HQPlayer 为准，不再报警；
  HQPlayer 播放列表为空时保留队列并提示，可一键推回；连接真实 HQPlayer 时不再恢复演示曲目队列。
- 不一致原因改为代码 + 中英文翻译（之前横幅显示英文）；通知也按代码翻译。
- 不用比 Studio 最后一次操作更早的 HQPlayer 状态做判断（加上 4 s 缓冲），避免操作后误报。
- 扫描音乐库后重新匹配 HQPlayer 正在播放的文件（之前“不在音乐库”的结果会一直缓存）。
- 网络共享路径：HQPlayer 的 file:// + \\NAS\share\… 形式不再被 URI 解码（含 % 的文件名不再匹配失败）。

Verified:
- 自动化测试 142 项全部通过；新增有状态替身引擎回归测试：播放中换专辑真的换、清空不留残留且停止、
  外部更改后接管保持同步、以 HQPlayer 为准不发送任何写命令、重启后过期队列自动跟随/匹配时保留/HQPlayer 为空时保留。
  去掉 Stop 后“清空”和“接管”测试会失败（证明测试能抓到这个 bug）。
- Mac 端到端彩排（替身引擎模拟“清空保留正在播放曲目”）：播放中换专辑 → 列表恰好为新专辑；外部更改 → 中文横幅；
  替换 → 确认 → HQPlayer 停止且列表一致、6 s 后仍同步；以 HQPlayer 为准 → HQPlayer 继续播放、面板显示其列表；
  播放中清空 → HQPlayer 空且停止；重启 Studio → 过期队列被静默替换为跟随 HQPlayer。

Known limitations:
- “跳到这首”/“上一首”在播放中用 SelectTrack(+Play)，真机上播放中切换是否立即生效尚未验证。
- 播放新专辑会先 Stop：从播放中切换会多约 4 s（HQPlayer 的 Stop 确认时间）+ 约 3 s 缓冲。
- 映射盘符（Z:\）与 UNC（\\NAS\…）指向同一文件时无法自动对应，请让 HQPlayer 与 Studio 用同一种路径。
- DSF/DFF 播放仍未在真机验证。

Next:
- 你：用 v0.1.5 重试——播放中换专辑、清空队列、在 HQPlayer 里改播放后用两个横幅按钮；顺便试“跳到这首”。
- Phase 2 / Phase 3 同上。
```

## 2026-11-10 — Phase 1 完成：Gate C 结果 + “允许 Studio 控制 HQPlayer”

```text
Implemented:
- 根据用户 Gate C 报告更新能力矩阵：Play / Pause（切换）/ Stop / Next / Seek / 装载（原生路径含中日文空格）/
  SelectTrack / PlaylistRemove（1 基）/ Repeat / Random → confirmed；Previous → observed（不可靠，改用组合实现）；
  Volume → 本机 unsupported（HQPlayer 已禁用远程音量）；连播在播放列表模式下无缝。
- 新增设置开关“允许 Studio 控制 HQPlayer”（默认关闭，立即生效，所有界面同步），只开放已验证命令；DSP/输出永不开放。
- Live adapter：暂停只在播放中发送；从暂停恢复用 Pause；“上一首”= Seek 0 或 SelectTrack(n−1)+Play；
  超时放宽（Stop ACK ≈ 3.8 s）；按 VolumeRange enabled 禁用音量；编辑 HQPlayer 播放列表后立即重读，队列同步不误报。
- 安全：演示音乐库的虚构曲目绝不发送到真实 HQPlayer（否则会清空你的播放列表并加入不存在的文件）。
- 文案：真实模式说明改为“默认只读，开启开关后可控制”；禁用按钮提示“在设置中开启允许控制”。

Verified:
- 自动化测试全部通过（新增：开关前后能力变化、幂等暂停/切换恢复/组合上一首、音量按引擎禁用、演示曲目拒绝且无引擎流量）。
- Mac 端到端彩排（有状态替身引擎）：扫描真实文件夹 → 开启开关 → 播放专辑（替身收到原生路径、匹配音乐库、队列同步）
  → 暂停/再次暂停保持/恢复 → 下一首 → 跳转 60 s → 上一首（重开本曲 / 回到上一首）→ 演示专辑被拒 → 音量被拒。

Known limitations:
- DSF/DFF 播放未在真机验证（测试文件夹没有 DSD 文件）。
- “下一首播放”在真实引擎下不可用（SDK 无对应命令）；音量需在 HQPlayer 或功放调节。
- 真实音乐库需要你在 设置 → 音乐库 添加文件夹并扫描（扫描器已实现，未在你的真实大库上测过性能）。

Next:
- 你：在 Studio v0.1.4 中 设置 → 音乐库 添加音乐文件夹并扫描；设置 → 播放与引擎能力 开启“允许 Studio 控制 HQPlayer”；
  从 Studio 播放一张专辑，确认 HQPlayer 播放、暂停、上/下一首、拖动进度正常。
- Phase 2：大库扫描性能与文件监听、封面（含 HQPlayer 正在播放曲目的封面）、Shift-JIS/GBK 标签。
- Phase 3：局域网配对，让手机遥控真正可用。
```

## 2026-11-10 — Gate C 工具（hqp-gatec.exe）

```text
Implemented:
- 按已批准计划（docs/gate-c-plan.md：C1–C4 + O1 Repeat/Random + O2 同值音量，本机备份）实现 hqp-gatec.exe：
  逐步确认（回车/跳过/中止并恢复）、命令白名单（拒绝 DSP/输出/配置/PlaylistSave 等）、音量只能设为原值、
  开始前备份当前播放列表（.m3u8 + .json，本机保留）、结束必恢复并逐条核对、可选 file:// 回退。
- 报告脱敏：测试文件记为 T1–T3/DSD，原列表条目记为 backup#n；HQPlayer 错误文本中的路径与已知文件名被去除
  （测试中发现 HQPlayer 风格的错误会回显路径，已修复）。
- CI：Windows 构建打包 hqp-gatec.exe 到 hqp-probe-windows-x64.zip，并冒烟测试（无 HQPlayer 时干净退出、不写文件）。

Verified:
- 自动化测试 11 项（全流程、中止后恢复、原生路径被拒时 file:// 回退、无测试文件夹不改列表、白名单/音量守卫、报告无隐私）。
- 真实编译的 hqp-gatec 可执行文件对有状态模拟引擎完整运行：29 个交互回答，所有步骤通过，恢复 6/6，
  最终停止、Repeat/Random/音量未变，只发送了白名单命令（模拟引擎行为为虚构，不作为 HQPlayer 证据）。

Next:
- 用户在 Windows 上运行 hqp-gatec.exe（约 20 分钟）并发回 hqp-gatec-report-*.json → 更新能力矩阵 →
  在 Studio 中加入“允许 Studio 控制 HQPlayer”开关，只开放通过的命令。
```

## 2026-11-10 — Phase 1：真机只读读取达成（播放状态）

```text
Implemented:
- 第二次探测（v0.1.1，播放中）确认：位置/时长单位为秒；output_delay 为微秒（本机 4.41 s）；
  Status 推送约 1 次/秒；<metadata> 给出明文 uri（file:// + 原始 Windows 路径）；Status track 与 1 基一致；
  当前为播放列表模式（album="0"）。能力矩阵 status.subscribe → confirmed。
- 进度显示改为“可听位置”（position − output_delay），与 HQPlayer 自身 min:sec 一致；新增 outputDelayMs 字段（供歌词同步）。
- 当前曲目优先按文件 URI 在 HQPlayer 播放列表中定位，并在运行时核对 Status track 编号基数（诊断页显示“已核对”）。
- “队列”面板：Studio 尚未安排队列时，显示 HQPlayer 自己的播放列表（只读，高亮当前曲目）；桌面与手机遥控共用。
- 修复播放条右侧音量读数被迷你播放器按钮遮挡：空间不足时先隐藏格式徽标（状态栏仍显示），再隐藏音量滑块。

Verified:
- 用户在 Windows 上用 v0.1.1 只读真实模式看到正在播放的曲目、PCM 48/24 → DSD512 (48k)、进度与 DSP 链（截图）。
  → Phase 1 退出条件“Windows 本机 Studio 能连接真实 HQPlayer 6 并稳定读取状态”达成。
- Mac 彩排（按第二份报告结构的临时替身）：可听位置 = 引擎位置 − 4.413 s 且每秒递增；按 URI 定位第 2 首；
  基数核对为 1；“队列”面板与诊断页高亮正确；1900 / 1536 / 1280 px 下音量读数不再与按钮重叠。
- 自动化测试全部通过（新增播放状态测试：12.544 s / 4413312 µs / 320.64 s / file:// URI）。

Known limitations:
- 写命令（播放/暂停/切歌/seek/装载/音量/DSP）仍全部禁用，等待 Gate C 授权。
- 真实模式下封面不显示（HQPlayer 的封面需另行读取，P1）；音乐库仍是演示数据（Phase 2 扫描真实目录）。

Next:
- Gate C（需用户明确同意 + 指定小测试专辑）：只读备份 HQPlayer 当前播放列表 → 逐项验证 Pause/Play/Next/Previous/Seek
  → 装载单曲/专辑（原生路径，含中文/日文/空格）→ PCM + DSF → 两首连播 → 恢复原播放列表。
- Phase 2：扫描真实音乐目录，使 HQPlayer 正在播放的曲目能匹配到 Studio 音乐库（封面、专辑跳转）。
```

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

| Phase                         | 状态                                                | 退出条件                                                                                            |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 0 仓库 + 风险隔离             | ✅ 完成                                             | Mac 上 install/dev/test/build ✔；Mock 播放/暂停/换歌/断线 ✔；CI 产出并冒烟测试 Windows 包与探测器 ✔ |
| 1 Desktop 6 API Spike         | ✅ 读写均已在真机验证（Gate C）；控制需用户开启开关 | 稳定读取真实状态；传输/装载结果有实测记录                                                           |
| 2 持久音乐库 + 播放列表       | 部分（数据层与扫描器已就绪）                        | 真实目录、重启不丢、CJK 路径、实际选专辑播放                                                        |
| 3 同步网页遥控                | 部分（本机已同步）                                  | 局域网配对、断线恢复                                                                                |
| 4 迷你播放器 / 歌词 / 设置 UX | 部分（迷你窗、设置分层）                            | 歌词、托盘/媒体键                                                                                   |
| 5 稳定性与发布                | 未开始                                              | 长时间 DSD512、备份/回滚、签名与声明                                                                |
