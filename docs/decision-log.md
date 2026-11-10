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
