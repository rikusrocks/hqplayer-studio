# Test matrix

## Automated (Mac + CI: ubuntu-latest and windows-latest)

`pnpm test` → 13 files, 110 tests (2026-11-10). No test needs an HQPlayer licence or audio hardware.

| Brief §11 requirement                                                      | Covered by                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playlist CRUD, ordering, duplicates, restart persistence                   | `packages/library/src/repositories/repositories.test.ts`, `packages/core/src/server.test.ts`                                                                                                      |
| Track/album uniqueness, metadata fallback, CJK Unicode, offline recovery   | `packages/library/src/normalize.test.ts`, `packages/library/src/scanner/scanner.test.ts` (real WAV files generated in temp dirs, CJK folder names, corrupt file, CD1/CD2, offline root → recover) |
| Queue concurrency, ACK timeout, reconnect state merge                      | `server.test.ts` (concurrent Desktop+Web album plays, `fail-next-command` → 504 with plan unchanged, disconnect → 503 → reconnect without autoplay)                                               |
| Album vs Playlist mode rules                                               | `server.test.ts` (album source/mode; queue edits switch to playlist mode), Live adapter marks Album Mode `unsupported`                                                                            |
| LRC parsing, offsets, multilingual                                         | `packages/lyrics/src/lrc.test.ts`                                                                                                                                                                 |
| LRCLIB client: User-Agent, one-at-a-time, 429/Retry-After, bad answers     | `packages/lyrics/src/lrclib.test.ts` (fake `fetch`, no network)                                                                                                                                   |
| More lyric sources: answer parsing, order, synced over plain, outages      | `packages/lyrics/src/providers.test.ts`, `match.test.ts`, `packages/core/src/services/lyrics.test.ts` (fake sources, no network)                                                                  |
| Local lyric / cover file names; migration 5 keeps covers                   | `packages/library/src/lyrics/local-lyrics.test.ts`, `artwork/local-artwork.test.ts`, `db/migrations.test.ts`                                                                                      |
| Online covers: opt-in, playing album only, picker, host allow-list         | `packages/core/src/services/covers.test.ts` (fake `fetch`, no network)                                                                                                                            |
| Local lyrics: sidecar `.lrc`, UTF-8/16/GBK/Shift-JIS, embedded tags, cache | `packages/library/src/lyrics/local-lyrics.test.ts` (synthetic FLAC/WAV, invented text)                                                                                                            |
| Lyrics service: opt-in, playing track only, never during scans, offsets    | `packages/core/src/services/lyrics.test.ts`, LAN limits in `packages/core/src/remote/remote.test.ts`                                                                                              |
| Mini Player bounds after monitor changes; media keys; tray menu            | `apps/desktop/src/main/window-state.test.ts`, `apps/desktop/src/main/desktop-shell.test.ts`                                                                                                       |
| TCP half/sticky packets, malformed XML, timeouts, unknown commands         | `packages/hqplayer-adapter/src/protocol/framer.test.ts`, `xml.test.ts`, `live/LiveHQPlayerAdapter.test.ts` (synthetic TCP server)                                                                 |
| Mock engine behaviour                                                      | `packages/hqplayer-adapter/src/mock/MockHQPlayerAdapter.test.ts`                                                                                                                                  |
| Security: CSRF/Origin, Host, non-loopback, artwork traversal, WS origin    | `server.test.ts`                                                                                                                                                                                  |
| Probe is read-only and sanitises                                           | `scripts/hqp-probe/src/probe.test.ts`                                                                                                                                                             |
| UI pure logic, i18n key parity                                             | `packages/ui/src/**/*.test.ts`                                                                                                                                                                    |
| Multi-monitor window restore                                               | `apps/desktop/src/main/window-state.test.ts`                                                                                                                                                      |

Additional gates in CI (`.github/workflows/windows-build.yml`): Electron packaged-app smoke test (`--smoke-test`: preload bridge present, no Node in renderer, Core health, `node:sqlite` inside Electron, remote served) and probe exe smoke test (unreachable port still yields a report).

Still to add (tracked in PROGRESS): 1000+ track scan performance fixture, browser-level UI tests (Playwright) for the main flows.

## Opt-in — real lyric and cover services (by hand, needs the network)

Not part of `pnpm test` or CI: they call third parties. A run sends a few dozen requests per source, one per second, and prints names and line counts only (never lyric text).

```sh
HQPS_LIVE_TESTS=all pnpm vitest run packages/lyrics/src/live.test.ts packages/core/src/services/covers.live.test.ts
HQPS_LIVE_TESTS=netease,kugou pnpm vitest run packages/lyrics/src/live.test.ts   # a list of sources
```

| Checks                                                                                  | File                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Search lists results; choosing a listed result delivers lyrics; automatic match         | `packages/lyrics/src/live.test.ts`                                        |
| Album search lists the album; its cover downloads as a real JPEG/PNG/WebP at full size  | `packages/core/src/services/covers.live.test.ts`                          |
| NetEase, search list → choice → lines on screen, against a stand-in with the real rules | `packages/core/src/services/lyrics-netease.test.ts` (runs in `pnpm test`) |

`HQPS_LIVE_NETEASE_URL=http://music.163.com` helps on a network that resets NetEase's HTTPS. Last run 2026-11-11 (Mac): NetEase (over HTTP), Kugou, lyrics.ovh, iTunes, Deezer, MusicBrainz passed; LRCLIB is blocked on that network.

## Manual — Mac (done 2026-11-10)

- [x] Desktop UI at 1440×900 against real Core + Mock: browse, album detail, play from track 3, player bar shows engine-confirmed DSD64 → DSD512.
- [x] Web Remote at 375×812: mirrors desktop Now Playing; "Play all" on a playlist from the phone updates the desktop queue.
- [x] Diagnostics → simulate disconnect: red status, transport disabled, queue "engine offline"; reconnect restores state without autoplay.
- [x] No console errors in either app.
- [x] Packaged macOS `--dir` build runs from asar (`SMOKE_OK`).

## Manual — Windows (needs the user; see PROGRESS "Windows action needed")

| #   | Check                                                                     | Expected evidence                                                                                                    |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| W1  | Run `hqp-probe.exe` with HQPlayer Desktop 6 open                          | ✅ 2026-11-10: engine 6.1.0, 19/19 read-only OK (stopped state)                                                      |
| W2  | Run `HQPlayerStudio-*-portable-x64.exe`                                   | App opens, MOCK badge, demo library, no HQPlayer interaction                                                         |
| W1b | Re-run probe v0.1.1 **while a track is playing**                          | ✅ 2026-11-10: seconds, output_delay µs, 1 Hz pushes, plain uri                                                      |
| W3  | Phase 1 (after W1): Live adapter read-only                                | ✅ 2026-11-10: user's screenshot of v0.1.1 showing the real playing track, format and DSP chain                      |
| W4  | Phase 1 Gate C (explicit consent, test album)                             | ✅ 2026-11-10: all approved steps pass except Volume (disabled in HQPlayer); DSF not tested (no file); restore 52/52 |
| W5  | Phase 2: scan the real music folder                                       | counts, unavailable handling, restart persistence                                                                    |
| W6  | Phase 3: iPhone/iPad on home LAN                                          | pairing, sync, offline messaging                                                                                     |
| W7  | Phase 4: Mini player on multi-monitor + scaling, media keys, tray, lyrics | position restore, always-on-top, keys/tray control HQPlayer, `.lrc` follows playback, LRCLIB only after opt-in       |
| W8  | Phase 5: long DSD512 sessions while scanning                              | no attributable dropouts                                                                                             |
