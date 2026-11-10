# Decision log

Format: problem · options · choice · why · risk · cost of reversing.

## D-001 Monorepo tooling — 2026-11-10

- **Options:** pnpm workspaces · npm workspaces · Nx/Turborepo.
- **Choice:** pnpm 12 workspaces, TypeScript 6.0 strict, ESLint 10 + typescript-eslint, Prettier, Vitest 5 (root `projects`).
- **Why:** brief asks for pnpm; internal packages export TS source (`exports: ./src/index.ts`) so no per-package build step — Vite/esbuild/tsx consume source directly.
- **Risk:** TypeScript 7 (native) is current, but typescript-eslint 8.72 requires `<6.1`; pinned `~6.0.3`. Revisit when typescript-eslint supports 7.
- **Reversal cost:** low.

## D-002 SQLite driver: `node:sqlite` instead of better-sqlite3 — 2026-11-10

- **Problem:** native addons must be rebuilt for Electron's ABI and for Windows; the user cannot build on Windows.
- **Evidence:** verified on this Mac that Electron 45.2.3 (Node 24.22.2) exposes `node:sqlite` with SQLite 3.53.4 and FTS5; Node 26.11 the same (incl. FTS5 trigram).
- **Choice:** `node:sqlite` (`DatabaseSync`), WAL, foreign keys on, hand-rolled transaction helper with savepoints.
- **Why:** zero native dependencies → the packaged app has no `node_modules`; CI smoke-tests SQLite inside the packaged Windows app.
- **Risk:** API marked "release candidate" in Node docs; small surface used (prepare/run/get/all/exec). Fallback: better-sqlite3 has a near-identical API.
- **Reversal cost:** low–medium (repositories only touch the minimal API).

## D-003 Core inside the Electron main process, renderer loaded from Core's loopback HTTP — 2026-11-10

- **Options:** custom `app://` protocol + IPC · renderer from `file://` + CORS · renderer served by Core over HTTP.
- **Choice:** Core runs in the main process on `127.0.0.1:47321` (falls back to a random port) and serves both UIs. Same origin → no CORS, the desktop UI and the remote use the identical REST/WS API.
- **Risk:** a heavy scan could delay main-process work. Mitigated by low scan concurrency and async I/O; can move Core into an Electron `utilityProcess` later without API changes.
- **Reversal cost:** low.

## D-004 Fastify + zod (not tRPC/GraphQL) — 2026-11-10

- **Why:** boring REST + one WS stream matches the brief's API draft; zod schemas in `contracts` validate both requests (server) and responses (client).

## D-005 Bundle everything with esbuild; electron-builder packages only `dist/` — 2026-11-10

- **Why:** avoids pnpm-symlink issues in electron-builder; smaller attack surface; verified the asar build runs (`--smoke-test`) on macOS. Windows CI runs the same smoke test on `win-unpacked`.

## D-006 Probe as a Node single-executable (SEA) — 2026-11-10

- **Options:** PowerShell script (execution policy friction) · probe inside the Electron app · standalone exe.
- **Choice:** Node 26 `--build-sea` → `hqp-probe.exe` (embeds the Node runtime: roughly 100–150 MB uncompressed, much smaller zipped). No install on Windows, double-click, sanitised JSON next to the exe.
- **Risk:** unsigned → SmartScreen prompt (documented in README-WINDOWS.txt).

## D-007 Protocol source of truth = official SDK 6.0.1, never guesses — 2026-11-10

- Downloaded `hqp-control-601-src.zip` (MIT). Command registry, framing (newline-terminated XML documents), status attributes, auth handshake and side-effect classes derived from it. SDK source is not committed.
- `HqpConnection` refuses non-SDK command names and (by default) any command with side effects.

## D-008 Live adapter is experimental and write-gated — 2026-11-10

- Read paths allowed while `untested` (side-effect free). Every write path checks `DESKTOP6_EVIDENCE`; until `confirmed/observed` or explicit Gate C consent (`allowUntestedWrites`) it throws `CapabilityUnavailableError` with no engine traffic. `dsp.write` stays disabled regardless.
- Album/Playlist mode marked `unsupported`: SDK has no switch command.

## D-009 Queue: engine-first commit, explicit takeover, no retry — 2026-11-10

- Plan is updated only after the engine accepted a command. Timeouts are reported (504) and not retried (a retried PlaylistAdd could queue tracks twice). External changes → `out_of_sync` (plan preserved). "Take over" re-sends the plan without autoplay. Sync checks pause while Studio's own command is in flight to avoid false alarms.

## D-010 Track identity = normalised path; album identity = artist + title + album folder — 2026-11-10

- `path_key`: NFC, forward slashes, lower-case on Windows/macOS. Deterministic ids (`sha256(path_key)`) survive DB rebuilds.
- Album grouping includes the album folder (CD1/Disc 2 sub-folders collapse to the parent), so same-titled releases/formats stay separate; MusicBrainz release id overrides when present.
- **Known gap:** moved files become new tracks (old ones marked unavailable). Move detection (size+duration+tags fingerprint) is P1.

## D-011 Search: normalised `search_text` + LIKE (FTS5 later) — 2026-11-10

- NFKC, case fold, katakana→hiragana, CJK brackets/punctuation stripped, apostrophes removed. Adequate for tens of thousands of tracks; FTS5 trigram (available in both runtimes) is the P1 upgrade for large libraries (trigram needs ≥3 chars, so CJK 2-char queries keep the LIKE path).

## D-012 Mojibake repair for Latin-1-decoded tags — 2026-11-10

- Found while testing: RIFF INFO (WAV) tags are decoded as Latin-1, so UTF-8 CJK titles arrived garbled. Repair only when the Latin-1 bytes form valid UTF-8 containing non-ASCII; genuine Latin-1 ("Café") is untouched. Shift-JIS/GBK legacy tags remain a P1 item.

## D-013 Loopback-only until pairing exists — 2026-11-10

- Server refuses to bind to non-loopback hosts in Phase 0. LAN access (Phase 3) will add one-time pairing codes, per-device tokens (cookie, HttpOnly, SameSite=Strict), Origin checks and rate limiting before the bind restriction is lifted.

## D-014 Demo data is fictional and generated — 2026-11-10

- 13 fictional albums (en/zh/ja, multi-disc, compilation, same-title different-format releases, PCM/DSD/MP3/WavPack/AIFF). Covers are procedurally generated SVG (text-free). No real recordings, lyrics or artwork in the repo.

## D-015 Licence & naming — 2026-11-10

- Code under MIT. "HQPlayer" is Signalyst's product name; README and app state clearly that Studio is an unaffiliated third-party client. Revisit naming before any public release beyond personal use.

## D-016 Trust probe evidence over SDK assumptions — 2026-11-10

- **Evidence:** probe of the user's HQPlayer Desktop 6 / engine 6.1.0 (19/19 read-only commands).
- **Changes:** playlist indexes are 1-based (converted at the adapter boundary); `Status tracks_total` is not the playlist length (0 vs 52) so the playlist length comes from `PlaylistGet`; stopped status has no metadata, so the current track is described from the cached playlist; engine URIs are `file://` + raw Windows path (first probe's sanitiser hid the `//`; confirmed by v0.1.1) and are parsed without URI-decoding.
- **Confirmed by the playing-state probe:** position/length in seconds; `Status track` consistent with 1-based numbering (31 of 52). Studio still locates the current track by URI first and verifies the base at runtime.

## D-017 Engine choice is a saved preference applied on restart — 2026-11-10

- **Options:** hot-swap adapters at runtime · preference + restart.
- **Choice:** preference in `app_settings` (`engine.adapter`), applied at start; precedence launch flag/env > preference > mock. The desktop app relaunches itself (portable builds relaunch the original `.exe` via `PORTABLE_EXECUTABLE_FILE`, because the unpacked temp copy is deleted on exit).
- **Why:** hot-swapping would have to re-plumb subscriptions, queue sync and capability caches mid-session for little benefit.

## D-018 Show the audible position, not the engine's processing position — 2026-11-10

- **Evidence:** while playing, HQPlayer reported `position` 12.544 s with `output_delay` 4,413,312 µs; its own `min:sec` was 0:08 (= position − delay). DSD512 + CUDA buffering puts ~4.4 s between processing and the DAC.
- **Choice:** `EngineStatus.positionMs` is the audible position (position − output_delay); `outputDelayMs` is exposed separately for lyrics timing. The progress bar therefore matches what is heard and what HQPlayer itself displays.
- **Risk:** Seek targets are engine positions; Gate C must check whether a seek to X lands audibly at X (expected, after the buffer refills).

## D-019 Control is opt-in, and only Gate C-confirmed commands are exposed — 2026-11-10

- **Evidence:** Gate C on the user's engine (engine 6.1.0): see docs/gate-c-plan.md §10.
- **Choice:** a persisted switch “允许 Studio 控制 HQPlayer” (default off, applied immediately without restart) enables write capabilities whose evidence is confirmed/observed; untested ones stay off; DSP/output writes are never exposed. The connection-level interlock follows the switch.
- **Behaviour derived from evidence:** Pause toggles → Studio sends Pause only while playing and resumes with Pause; HQPlayer's Previous was inconclusive → “previous” = Seek 0 (> 3 s) or SelectTrack(n−1)+Play; Stop ACKs in ~3.8 s → adapter timeout 10 s, engine command timeout 20 s; Volume rejected while `VolumeRange enabled="0"` → volume.set unusable at runtime.
- **Safety:** the fictional demo library can never be sent to a real engine (it would replace the user's playlist with non-existent files). After Studio edits HQPlayer's playlist, the adapter re-reads it before returning so queue sync never sees a stale length.

## D-020 Replacing HQPlayer's playlist always stops first; the user can follow HQPlayer — 2026-11-10

- **Evidence:** user report on v0.1.4: “clear queue leaves a music file” and “playing a new album keeps playing the same”. Explained by HQPlayer keeping the playing entry on `PlaylistClear` (Gate C only cleared a stopped engine). Gate C C4: `Stop` on a stopped engine ACKs in 0 ms.
- **Choice:** every load/clear sends `Stop` → `PlaylistClear` → `PlaylistGet` (leftovers removed with `PlaylistRemove`, else error) → adds → `PlaylistGet` (count must match) → `SelectTrack` → optional `Play`. Never select or play on a playlist that is not exactly Studio's.
- **Queue sync:** two explicit resolutions — “以 HQPlayer 为准” (read-only: adopt HQPlayer's playlist when every entry is in the library, otherwise drop Studio's plan) and “用 Studio 队列替换 HQPlayer” (confirmed, stops playback). A plan restored at startup that disagrees with a non-empty HQPlayer playlist follows HQPlayer silently. Engine statuses older than Studio's own last change, or within 4 s of it, never flag a mismatch. Sync reasons are codes translated by clients.
- **Trade-off:** switching albums mid-playback costs HQPlayer's Stop time (~3.8 s) — correctness over speed.

## D-021 Clear only after HQPlayer reports "stopped" — 2026-11-10

- **Evidence:** v0.1.5 still left one song after “clear”. Gate C's clear (which passed) ran only after waiting for the pushed `Status state="0"`; v0.1.5 cleared right after the `Stop` ACK. Conclusion: the ACK precedes the actual stop, and the active entry can't be cleared or removed until then.
- **Choice:** after `Stop`, wait (≤ 6 s) for a Status with `transport = stopped` observed after the Stop was sent, then clear; leftovers → `PlaylistRemove` → 1 s pause → retry, three attempts, then a clear error. A privacy-safe protocol timeline (“复制诊断信息”) records each step so the next real-engine report is evidence rather than inference.

## D-022 Library stays current by watching folders, with a slow fallback — 2026-11-10

- **Choice:** `fs.watch(root, { recursive: true })` per root → debounce (4 s quiet, ≤ 30 s) → rescan only the changed folders; full incremental fallback every 12 h (1 h for roots that can't be watched); no forced scan at startup. Moved/renamed files keep their track id when the old path is gone and size+mtime+file name match (a copy stays a new track).
- **Performance:** cached prepared statements and ~200-file write batches; file reads (not stats) wait 25 ms each while HQPlayer is playing; automatic scans only look for artwork of changed albums.
- **Trade-off:** watcher events on some SMB/NAS shares are unreliable — those roots show “无法监听” and rely on the hourly fallback.

## D-023 Recover GBK / Shift-JIS tags automatically, conservatively — 2026-11-10

- **Problem:** old Chinese/Japanese taggers wrote the Windows code page into Latin-1 tag fields; parsers return mojibake.
- **Choice:** for Latin-1-only strings with ≥ 2 high bytes that are not valid UTF-8 and not European-looking (isolated accented letters), score GBK vs Shift-JIS by _byte ranges_ (GB2312 core hanzi vs kana/level-1 kanji; extension areas and half-width katakana penalised), all fields of a file together, folder/file name as hint; require a clear margin, else leave the text untouched. Big5 is not auto-detected (indistinguishable from GBK without frequency data).
- **Evidence:** synthetic sample: 44/44 Chinese, 28/30 Japanese recovered, 0 wrong. Electron's runtime is checked for the decoders in the Windows smoke test.

## D-024 Library hygiene: removal, nesting, folder albums — 2026-11-10

- **Remove folder:** deletes the folder's tracks, now-empty albums/artists, playlist entries and saved-queue entries in one transaction; the in-memory queue plan that used them is dropped; files are never touched; removing the demo library sets `library.demoRemoved` so it is not re-seeded.
- **Nesting:** a folder inside a library folder is refused; a parent of library folders absorbs them (track ids kept → playlists intact; `mtime_ms` cleared so files are re-read relative to the new folder). The fictional demo root never takes part.
- **Folder = album:** merge albums inside one album folder only with strong numbering evidence (see `planFolderAlbum`); otherwise leave them separate. Online confirmation (MusicBrainz) is deferred and must be opt-in because it sends album/artist names to a third party.
- **Jump while playing:** try SelectTrack+Play; if the playing file does not change within 2.5 s, fall back to Stop → stopped → SelectTrack → Play (the Gate C-verified sequence).

## D-025 Studio may start HQPlayer and hide its window — never reconfigure it — 2026-11-10

- **Request:** “open HQPlayer with Studio, or leave it running silently — I don't want to see the original HQPlayer”.
- **Choice (Windows):** detect `HQPlayer*.exe` from the Uninstall registry entries / `Program Files\Signalyst` (or a user-picked path), start it detached (it outlives Studio), and show/minimize/hide its top-level windows via Win32 `ShowWindow` through PowerShell (`-EncodedCommand`, parameters only via environment variables). Preferences in `app_settings` (`hqplayer.app`). Nothing in HQPlayer's install or configuration is changed.
- **Risk:** HQPlayer's window/class names are unverified on the user's machine; “show” restores Qt top-level windows (`QWindowIcon`) or ones titled “HQPlayer”.
- **Amended by D-033:** the start no longer depends on the window step, the window mode is applied by a watcher (and again when HQPlayer connects), and every step reports its outcome.

## D-026 Volume: follow HQPlayer's "Fixed volume" setting, cap increases — 2026-11-10

- **Evidence:** user screenshot of HQPlayer Settings → Outputs: “Fixed volume” ticked (min −60 dB, max −3 dB greyed). Unticking it lets the volume change. This explains Gate C's rejected Volume and `VolumeRange enabled="0"`.
- **Choice:** `volume.set` evidence → observed; usable only with the control switch **and** `VolumeRange enabled="1"` (otherwise note `fixed-volume` with instructions). VolumeRange is re-read every 10 s while connected, and capability changes are pushed to clients. Values are clamped to HQPlayer's range; one command raises the level by at most 12 dB (decreases unlimited).

## D-027 Web Remote on the LAN: separate listener, one-time pairing, per-device tokens — 2026-11-10

- **Problem:** phones on the home LAN must control Studio (handoff Phase 3) without weakening the loopback-only desktop path, without exposing settings/diagnostics/paths, and without bypassing anything on the network (§12.2–12.4).
- **Options (listener):** bind the existing app to 0.0.0.0 and branch on the client address · forward a second `http.Server` into the same Fastify instance · **a second Fastify app built from the same services**.
- **Choice:** one app per listener (`buildStudioApp(services, 'local' | 'lan')`). The loopback app and its security hook are unchanged. The LAN app starts only when the user turns it on (Settings → 网页遥控, default off) and binds one chosen RFC 1918 IPv4 address — never 0.0.0.0, loopback, link-local, CGNAT/VPN (100.64/10) or public. After a DHCP change it follows the same interface; if that interface has no private address it stops instead of moving elsewhere. Settings, diagnostics, mock controls, library-root add/remove, scans and remote management are simply not registered on the LAN app (404), and `isTrustedRequest` is false there whatever the address.
- **Options (auth):** cookie session · bearer token · token in query string (rejected: logged/leaked by URLs).
- **Choice:** 6-digit one-time code shown on the PC (5 min, single use, burned after 5 wrong guesses, 10 tries per address per 10 min; QR = remote URL + `#pair=<code>`, a fragment never sent to the server) → 256-bit device token, stored as SHA-256 in `remote_devices` (migration 3). HTTP sends `Authorization: Bearer`; the WebSocket offers `hqps.v1` + `hqps.auth.<token>` and the server only ever selects `hqps.v1`. `<img>` can't send headers, so pairing also sets an HttpOnly, SameSite=Strict cookie scoped to `/api/v1/artwork` holding a key derived from the token (HMAC) that unlocks artwork only. Deny by default: every `/api/` request except pairing status/pair needs a device; Host must be the bound address (page loads by PC name are redirected to it, API calls refused), same-origin Origin for writes/WS, cross-site fetch metadata refused, JSON-only writes, 1200 requests/min per address, 30 auth failures per 10 min → blocked. Revoking a device deletes its row and closes its WebSockets with 4401; the phone returns to the pairing screen.
- **Privacy:** every LAN JSON payload and event passes `sanitizeForLan` (engine `uri` → opaque id; Windows/UNC/file:/home paths in any string → `‹path›`). The demo mock already leaked `D:\Music\…` in `engine.status.track.uri` — a test fails if the sanitiser is removed.
- **Risk:** plain HTTP inside the home network: anyone able to sniff the Wi-Fi could capture a token (documented in Settings; HTTPS with a self-signed certificate is painful on iOS and is deferred). iOS keeps Home Screen web apps' storage separate from Safari, so a Home Screen remote pairs once more; Safari may clear site data of rarely used sites.
- **Reversal cost:** low — the LAN app is additive; turning it off restores the Phase 2 surface exactly.

## D-027 Backup copies are hidden, not deleted; online album check is opt-in and narrow — 2026-11-10

- **Duplicates:** an album is a copy when album artist + title + the sorted disc/track/title list are equal. Keep one visible (available → DSD → lossless → sample rate → bit depth → oldest); others get `albums.duplicate_of` and are excluded from album/track/artist lists, search and stats. Recomputed after each changing scan and root removal, so availability decides which copy is shown. Different editions (other track lists) stay separate.
- **MusicBrainz (opt-in, off by default):** only for album folders the local rules cannot settle; sends album title + album artist (never paths), User-Agent “HQPlayerStudio/<version> ( third-party HQPlayer library client )” (no personal contact), ≤ 1 request/s, 503 retried once. Join only if ≥ 80 % of the folder's tracks match a release (title, position+length, or length). Answers cached in `online_lookups`; “no match” retried after 30 days. The user accepted that indie coverage is limited — unmatched folders are left unchanged.

## D-028 Lyrics: local first, LRCLIB only on opt-in and only for the playing track — 2026-11-10

- **Problem:** handoff §8.4 wants synced lyrics with offsets, local files first, online search optional. LRCLIB is a third party: every lookup sends the track's title, artist, album and duration.
- **Options (where):** fetch in each client (desktop renderer, phone) · **in Core** · prefetch the whole queue/album.
- **Choice:** `LyricsService` in Core. Order: hand-picked LRCLIB match > `<same name>.lrc` next to the audio file (any case; UTF-8/UTF-16 BOM, GBK/Shift-JIS via the D-023 detector) > lyrics in the tags (music-metadata `common.lyrics`, read once per track) > stored LRCLIB result > LRCLIB online. Online is **off by default** (`lyrics.online`, Settings → 歌词 with a confirmation that says what is sent), and even when on it runs only for the track HQPlayer is playing (or Studio's current queue item) — browsing, scans and other tracks never trigger it; the fictional demo library gets invented demo lyrics and is never sent.
- **LRCLIB rules:** one request at a time, ≥ 1 s apart; 429 → honour `Retry-After` (seconds or date; default 60 s; capped at 1 h); network errors/5xx → 30 s pause; during a pause nothing is sent and clients show “暂时不可用” (playback unaffected) and retry after the pause. `/api/get` (exact signature) then at most one `/api/search`, picking by normalised title/artist and duration ±2 s. LRCLIB's “not found” is remembered for 7 days. User-Agent `HQPlayerStudio/<version> (unofficial HQPlayer Desktop client)` — LRCLIB recommends a homepage link “if available”; it is left out because it would carry the maintainer's GitHub account name to a third party.
- **Evidence gap:** lrclib.net/docs is blocked by the development Mac's network filter, so the client follows the API as documented publicly (`/api/get`, `/api/get/{id}`, `/api/search`, 404 `TrackNotFound`) and validates every answer; the first real lookup happens on the user's Windows PC.
- **Timing:** `EngineStatus.positionMs` is already the audible position (D-018), so LRC times compare directly; the per-track user offset (positive = later, ±30 s) is stored in `lyrics_cache.offset_ms`, shared over `lyrics.changed`, and phones may change it.
- **Storage:** existing `lyrics_cache` (no migration): `source` = `local | embedded | lrclib | demo | none` (none = LRCLIB had nothing), `selected_by_user` for manual matches. Lyric text never goes into logs, errors or diagnostics (diagnostics only carry counts); LAN payloads pass `sanitizeForLan` as usual.
- **LAN surface:** phones may read lyrics and calibrate; LRCLIB search/selection, re-match, lyrics settings and cache clearing exist only on the loopback app.
- **Risk:** a wrong automatic match → “搜索 LRCLIB…” (manual pick wins) and “重新匹配”; local `.lrc` edits are picked up on the next request. **Reversal cost:** low.

## D-029 Mini Player placement, media keys and tray — 2026-11-10

- **Mini Player:** restored with `restoreBounds`: the mini window is always kept fully on one display, the main window keeps a place that is at least partly visible, otherwise both are pulled onto the display they overlap most / the nearest one (size kept, shrunk if larger than the screen) instead of falling back to the default position. Bounds are re-checked on `display-added`, `display-removed`, `display-metrics-changed` (scaling) and when the main window is restored. “Always on top” is persisted in `window-state.json` and shown correctly when the mini window opens.
- **Media keys (Windows):** `globalShortcut` for Play/Pause, Next, Previous, Stop, on by default with a switch in Settings → 常规. They call `EngineService.transport` — the same capability-checked path as the buttons — so with control off nothing reaches HQPlayer and a (throttled) notice explains why. A key another program already holds is reported, never fought over. Not on macOS (would need accessibility permission; the Mac is only for development).
- **Not possible:** Windows' media overlay / lock screen (SMTC) needs an audio session; Studio plays no audio, so it cannot appear there — said in Settings rather than faked.
- **Tray:** opt-in icon (the remote's PWA icon at 16/24/32 px) with now-playing line, Play/Pause, Previous, Next, Mini Player, Show HQPlayer Studio, Quit; labels follow the UI language. Separately opt-in “关闭主窗口时继续在后台运行” (only with the tray icon) keeps the Web Remote and media keys alive after closing the window.
- **Testability:** the decisions live in pure functions (`desktop-shell.ts`, `window-state.ts`) with unit tests; Electron wiring stays thin. The packaged-app smoke test skips media keys/tray.
- **Risk:** while Studio runs, browsers no longer receive the media keys (switch them off in Settings). **Reversal cost:** low.

## D-030 Settings page in layers — 2026-11-10

- **Problem:** §8.5 — users must see what Studio can change and what only HQPlayer can; no fake controls.
- **Choice:** every settings block carries one of four tags, explained in a legend: `Studio 设置` (stored by Studio), `HQPlayer · 可控制` (Gate C-confirmed commands, needs the control switch), `HQPlayer · 只读` (read from HQPlayer), `仅在 HQPlayer 中` (Studio neither reads nor changes it). New sections **输出** (signal path, output buffer, volume range, device/driver = HQPlayer only) and **歌词**; **DSP** becomes a table of current values with “where to change it” (convolution/matrix/CUDA: “Studio 无法读取”) and explains why DSP writes stay off (D-008). “Open in HQPlayer” = “显示 HQPlayer 窗口” when Studio knows the program (D-025), otherwise an instruction. General gains 桌面集成 (Mini Player on top, media keys with their live status, tray).

## D-031 DSP commands get their own gate tool; Gate C stays DSP-free — 2026-11-10

- **Request:** control mode / filter / shaper / rate from Studio so the native HQPlayer window is not needed for everyday changes.
- **Unknowns the SDK does not answer:** whether `SetMode` / `SetFilter` / `SetShaping` / `SetRate` take a list `index` or a list `value` (every list item has both); whether the shaper/rate lists depend on the mode; whether one-value `SetFilter` sets both 1x and Nx; what a change does during playback.
- **Choice:** a separate `hqp-dspgate.exe` (`scripts/hqp-probe/src/dspgate/`) with its own allowlist, rather than widening `GATE_C_ALLOWED`. Each step changes one setting, confirms it with `State`, reverts it and compares the whole `State` with the starting snapshot; a step that cannot be reverted stops the run. Guard: a selector value must be an `index` or `value` from the list read last on that connection; rates are only lowered within the same family; a matrix profile is only switched when the current one is listed (so it can be put back). Never sent: `Reset`, `ConfigurationLoad`, `SetTransport*`, `SetDisplay`, `SetJunkFilter`, `Volume`, playlist edits.
- **Index-or-value discovery:** the index is tried first, then the value; whichever makes `State` show the target is recorded per selector. If the two numbers are equal for the items used, the finding is “ambiguous”, not a guess.
- **Not covered:** whether a change survives an HQPlayer restart (the tool reverts everything). `dsp.write` stays unusable in Studio until a report from the user's engine is in.

## D-033 Starting / hiding HQPlayer: independent steps, every outcome reported — 2026-11-10

- **Problem:** on the user's PC HQPlayer never started with Studio and “hide” did nothing, with no message (D-025 was only ever tested with Notepad on CI). Not reproducible on the development Mac; causes found by reading the code: the start waited on a PowerShell window listing (blocked `Add-Type`, timeout → no start), every error was swallowed, the window mode was applied once to the first visible window and only at Studio startup, and detection was unconfirmed.
- **Choice:** amend D-025's mechanics, keep its rules (Studio only starts the program and shows / minimizes / hides its windows; it never changes HQPlayer's installation or settings and never auto-plays; both options stay off by default).
  - **Steps are independent.** “Is it running” comes from `tasklist /FO CSV /NH` (if that fails: is the control port 127.0.0.1:4321 answering); the start is a detached `spawn` whose `spawn` / `error` event is awaited, with Electron `shell.openPath` (ShellExecute, same as a double click) as fallback when the direct start is refused; PowerShell is used only for windows, so its failure can no longer prevent the start. Any process that looks like HQPlayer Desktop counts as running, so a second copy is never started.
  - **Window watcher** instead of a one-shot: poll `hide` / `minimize` and act on every window that became visible; after a start run at least 30 s, stop after 10 s without changes, give up at 90 s; when HQPlayer was already running: 6 s quiet, 20 s limit. Two failed polls in a row end it with the error. It also runs when the engine connection comes up and when the window setting changes; a manual show / hide cancels it. Visible windows without a title are hidden too (a splash screen need not have one); `minimize` skips windows that are already minimized. In hidden mode the start carries Windows' `SW_HIDE` startup hint (`windowsHide`) — a hint only, HQPlayer may ignore it.
  - **Detection:** Uninstall registry keys found with `/f HQPlayer /d`, then each key read in full → Start-menu / desktop shortcuts (`shell.readShortcutLink`) → `Program Files\Signalyst\*` and `Program Files\*HQPlayer*` → the path where HQPlayer was last seen running (learned from a running process via `Get-Process`, stored in Studio's own `hqplayer.app.seen`). A user-picked path that no longer exists falls through to detection.
  - **Reporting:** each run produces an `HqpRunReport` (executable: found / where it looked; process: running / started / start error; window: what was hidden or the error). The last six are kept in memory (the startup one is never dropped), shown in Settings → HQPlayer 程序, raised as a toast when a requested start or the window step fails, and added to “复制诊断信息” as `hqplayerApp` with folders removed (file names only) and window titles reduced to their length. PowerShell errors are returned as one `HQPS_ERROR [<language mode>] <message>` line instead of CLIXML.
- **Not chosen:** a native addon for window control (packaging cost; revisit if PowerShell `Add-Type` turns out to be blocked on the user's PC) · switching the defaults to “start + hide” (hiding another program's window should stay an explicit choice) · remembering which window handles Studio hid so “show” restores exactly those (still the D-025 heuristic: titled windows matching `QWindowIcon|HQPlayer`).
- **Risk:** still unverified against a real HQPlayer 6: its executable name, whether it shows a splash screen, how long the main window takes, whether it honours the startup hint, and whether hiding a start-up error dialog leaves it waiting unseen (the user can bring it back with “显示 HQPlayer”). **Reversal cost:** low.

## D-034 More lyric sources: each one opt-in, tried in order, still only for the playing track — 2026-11-11

- **Problem:** LRCLIB alone misses a lot of the user's library (Chinese songs above all), and a `.lrc` was only found when it had exactly the audio file's name.
- **Choice (online):** three more sources behind the existing `lyrics.online` switch, each with its own switch (`lyrics.providers`; unset = LRCLIB only, so nobody is opted into a new third party by an update): **NetEase Cloud Music**, **Kugou Music**, **lyrics.ovh** (plain lyrics only). Fixed order LRCLIB → NetEase → Kugou → lyrics.ovh; the first source with synced lyrics (or an "instrumental" answer) wins, plain lyrics are kept in hand while the remaining sources are asked. D-028's rules are unchanged and apply to every source through the shared `PoliteHttp` (one request at a time per source, ≥ 1 s apart, 429/Retry-After, back-off after errors — doubling up to 15 min for the new sources, bodies never in errors): only the playing track, never scans or albums, "not found" remembered 7 days.
- **Outages:** a source that cannot answer is skipped. If nobody had lyrics and some source was down, the state is `unavailable` and the retry asks only the sources that had not answered yet (remembered per track for the session), so a blocked source does not cause repeated traffic to the healthy ones.
- **Matching:** besides the names as tagged, the cleaned title ("(Remastered 2009)", "[Live]", "- 2011 Remaster", "feat. X", 现场版/主题曲 brackets) and the first credited artist are tried; durations must agree within ±3 s (LRCLIB keeps ±2 s). Brackets that may mean other words ("(Part 2)", 粤语版) are left alone.
- **Terms:** LRCLIB and lyrics.ovh are open APIs. The NetEase and Kugou interfaces are the ones their own web/desktop players use; neither is a documented third-party API. They are therefore off until the user enables them, the settings say so in plain words, a confirmation names the service before the first lookup, and traffic is one track at a time. Lyrics stay on this computer (D-028 storage rules). Revisit before any public release beyond personal use.
- **Evidence:** Kugou and lyrics.ovh verified against the live services from the development Mac (search + download, synced LRC / plain text). music.163.com and lrclib.net are blocked by that Mac's network filter, so the NetEase client follows the publicly known answer shapes (old `artists/album/duration` and new `ar/al/dt`), validates every answer and pauses on any `code` other than 200; its first real lookup happens on the user's PC.
- **Manual matching:** search lists candidates of every enabled source (`provider` + opaque `ref` instead of `lrclibId`); a source that is down is left out, 503 only when none answers.
- **Choice (local):** a lyrics file is also found as `Song.lrc`, `Artist - Song.lrc`, `Song - Artist.lrc`, the audio file's name without its track number, a same-named `.txt` (plain), and all of these in a `Lyrics` / `Lyric` / `LRC` / `歌词` sub-folder. The exact name still wins. `.txt` needs the exact name so that notes are not shown as lyrics.
- **Storage:** `lyrics_cache.source` gains `netease | kugou | lyricsovh` (the column has no CHECK constraint; no migration). **LAN surface:** unchanged — phones read lyrics and calibrate; search, selection and settings stay on the loopback app.
- **Reversal cost:** low — switch a source off; "清除在线歌词缓存" forgets what it delivered.

## D-035 Covers: wider local search, opt-in online sources — 2026-11-11

- **Problem:** albums without a `cover.jpg`-style file or an embedded picture showed a placeholder, and the folder search only knew nine exact lower-case file names.
- **Choice (local):** `findLocalArtwork` (scanner and "恢复本地封面" share it): well-known base names in any letter case as JPG/PNG/WebP (`cover`, `folder`, `front`, `albumart`, `album`, `artwork`, `albumartsmall`, `thumb`) → any image whose name contains cover/front (not back/inlay/booklet/disc) → the folder's only image → the same in `Artwork` / `Covers` / `Scans` / `Art` / `Images` / `封面` sub-folders (no "only image" guess there) → the parent folder for disc folders → the embedded picture. One directory listing instead of nine failed opens; files over 12 MB are skipped.
- **Choice (online):** `CoverService` in Core with **iTunes Search**, **Deezer** and **MusicBrainz + Cover Art Archive** (all documented public APIs; MusicBrainz shares the album check's rate-limited client). Off by default (`covers.online`, Settings → 音乐库 → 封面, confirmation says what is sent); sources can be switched off one by one (`covers.providers`). Only album title + album artist are sent, never paths.
- **When:** by itself only for the album of the track that is playing **and** has no cover (same spirit as D-028). Everything else is the user's act: "查找封面…" on the album page (candidates from every enabled source, thumbnails proxied by Core because the page's CSP allows Studio's own images only), and "为所有缺封面的专辑查找" in Settings — a paced background job with progress and stop. Scans never go online. A cover found on disk is never replaced automatically.
- **Matching (automatic):** title equal after dropping decorations, artist compatible; compilations / unknown artists need the same track count instead; equal or close track count ranks first; up to three images per source are tried (many MusicBrainz releases have no cover). "Nothing found" is remembered 30 days in `online_lookups` (`cover:<albumId>`), but not while a source was unreachable.
- **Undo:** "恢复本地封面" drops the album's cover and reads folder + tags again (also picks up an image added later). If there is none, the album stays without a cover and is not looked up automatically again.
- **Security:** a candidate's `ref` is validated per source (iTunes artwork URL pattern on `*.mzstatic.com`, Deezer image hash, MusicBrainz release id) and the download URL rebuilt from it — a client never supplies a URL. Downloads are HTTPS only, redirects followed by hand (≤ 4) and only within the source's hosts (`mzstatic.com`, `dzcdn.net`, `coverartarchive.org` / `archive.org`), capped at 12 MB, and accepted only if the bytes are JPEG/PNG/WebP (the Content-Type header is not trusted; SVG stays impossible). All cover routes exist only on the loopback app.
- **Storage:** migration 5 rebuilds `artwork_cache` so `source` may be `online` (SQLite cannot alter a CHECK). Dropping the old table would fire `albums.artwork_id ON DELETE SET NULL`, so the album → artwork links are parked in a temp table and restored; covered by a migration test on a 0.3.0-shaped database. Whether an album's cover is "local" or "online" is read from the lookup record, not from the content-addressed cache.
- **Evidence:** all three sources verified live from the development Mac (search answers, image sizes, the Cover Art Archive redirect to archive.org); automatic lookup and the picker checked in the running app with a synthetic album.
- **Risk:** a wrong automatic match (same title + artist, different edition artwork) → pick another or restore the local cover. **Reversal cost:** low.
