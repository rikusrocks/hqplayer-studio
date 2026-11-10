# Architecture

```text
                          Windows music PC
 ┌──────────────────────────────────────────────────────────────────────┐
 │  HQPlayer Studio.exe (Electron 45)                                   │
 │   ├─ main process                                                    │
 │   │    ├─ Studio Core (Fastify, in-process)  http://127.0.0.1:47321   │
 │   │    │    ├─ REST  /api/v1/*        (zod-validated, versioned)      │
 │   │    │    ├─ WS    /api/v1/events   (engine/queue/library events)   │
 │   │    │    ├─ static /        → desktop renderer                     │
 │   │    │    └─ static /remote/ → web remote                           │
 │   │    ├─ EngineService ── HQPlayerAdapter (Mock | Live TCP/XML)      │
 │   │    ├─ QueueService  (planned queue, sync detection)               │
 │   │    ├─ LibraryService (scan jobs)                                  │
 │   │    └─ SQLite via node:sqlite (WAL)  %APPDATA%/HQPlayer Studio/data │
 │   ├─ renderer (React, sandboxed, no Node) ── window.studioShell       │
 │   └─ mini player window (#/mini)                                     │
 │                         │ 127.0.0.1:4321 (TCP, XML docs + "\n")       │
 │                         ▼                                            │
 │              HQPlayer Desktop 6 (unchanged, licensed)                │
 │                 DSP / CUDA / ASIO / NAA → DAC                         │
 └──────────────────────────────────────────────────────────────────────┘
        ▲ Web Remote LAN listener (off by default; Settings → 网页遥控):
        │ <private LAN IPv4>:47321 — paired devices only, /remote/ + allow-listed /api/v1
   phone / tablet browser → http://192.168.x.y:47321/remote/
```

On the Mac the same Core runs standalone (`pnpm dev:core`) with `MockHQPlayerAdapter` and the fictional demo library; Vite dev servers proxy `/api` to it.

## Packages

| Package                     | Responsibility                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts`        | Zod schemas + TS types for every DTO, request and WS event. Single source of truth across processes.                                                                                                                                                   |
| `packages/hqplayer-adapter` | `HQPlayerAdapter` interface; `MockHQPlayerAdapter`; SDK-derived protocol layer (XML parser/serializer, newline framer, command registry with side-effect classes, `HqpConnection`); experimental `LiveHQPlayerAdapter`; Desktop 6 capability evidence. |
| `packages/library`          | `node:sqlite` database, migrations, repositories (library, playlists, queue snapshot, settings), scanner (music-metadata), artwork cache, demo seed.                                                                                                   |
| `packages/core`             | Fastify server, security hooks, `EngineService`, `QueueService`, `LibraryService`, event hub, bootstrap.                                                                                                                                               |
| `packages/api-client`       | Typed fetch client (responses validated against contracts) + reconnecting WS client.                                                                                                                                                                   |
| `packages/ui`               | Shared React components, tokens, i18n (zh-CN/en), `StudioProvider` data layer.                                                                                                                                                                         |
| `packages/lyrics`           | LRC parsing + active-line lookup (LRCLIB client in P1).                                                                                                                                                                                                |
| `apps/desktop`              | Electron main/preload + desktop renderer.                                                                                                                                                                                                              |
| `apps/remote`               | Mobile-first web remote (served by Core at `/remote/`).                                                                                                                                                                                                |
| `scripts/hqp-probe`         | Read-only Gate A/B probe, built to a single Windows `.exe` (Node SEA).                                                                                                                                                                                 |

## State ownership

| State                                                          | Authority                             | Notes                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport, position, current track, output format, DSP summary | **HQPlayer**                          | `EngineStatus` is only ever built from engine reports (or `disconnected`). No optimistic transport state; UI shows pending until the next status.                                          |
| Library, saved playlists, preferences                          | **Studio (SQLite)**                   | Scans never delete tracks; playlists reference tracks with `ON DELETE RESTRICT`.                                                                                                           |
| Planned Now Playing queue                                      | **Studio**, verified against HQPlayer | Commands go to the engine first; the plan is committed only after the engine accepts. Divergence → `sync.state = out_of_sync` + explicit “Take over” (re-sends the plan, never autoplays). |

## Command path

1. REST request → zod validation → capability check (`EngineService.require`) — untested/unsupported capabilities return `409 capability_unavailable` before any engine traffic.
2. `EngineService.run()` serialises the call (single flight across Desktop + Web) and applies a backstop timeout. Timeouts return `504 engine_timeout` and are **never retried**.
3. Adapter executes; engine status flows back via `subscribeStatus` → `engine.status` WS event → `QueueService` sync check → `queue.changed`.
4. On reconnect Studio only re-reads state — it never sends Play, volume or DSP changes by itself.

## Security posture

- The main listener binds to `127.0.0.1` only (`createStudioServer` refuses anything else). LAN access is a **separate** Fastify app (`buildStudioApp(…, 'lan')`, see D-027) that runs only when the user enables it, on one private IPv4 address.
- `onRequest` hook: loopback remote address, loopback `Host` (anti DNS-rebinding), loopback `Origin` for writes and WS upgrades (anti CSRF), `application/json` required for writes. Rejected WS upgrades are answered and closed on the raw socket.
- HTML is served with a CSP header; artwork is served only by validated content-hash id (no paths), SVG only if generated by Studio, with a restrictive CSP.
- Electron: `contextIsolation`, `sandbox`, no `nodeIntegration`, permission requests denied, navigation locked to the Core origin, new windows denied (https links open in the system browser), IPC accepted only from Core-origin frames.
- Track DTOs never contain absolute paths; library root paths are only returned to loopback clients.
- LAN app (Web Remote): one-time 6-digit pairing code → per-device token (SHA-256 at rest, `remote_devices`), sent as `Authorization: Bearer` / WebSocket subprotocol `hqps.auth.<token>` (never in a URL); artwork via an HttpOnly SameSite=Strict cookie scoped to `/api/v1/artwork`. Deny by default, Host = bound address, same-origin Origin for writes/WS, JSON-only writes, per-address rate limits and auth-failure blocking. Settings, diagnostics, mock, library-root/scan writes and remote management are not registered there. Every LAN payload/event is path-sanitised (`sanitizeForLan`). Revocation closes the device's WebSockets (code 4401).
- `HqpConnection` is read-only by default (writes need explicit opt-in), and refuses commands that are not in the SDK registry.

## Data locations

| Context  | Location                                                                              |
| -------- | ------------------------------------------------------------------------------------- |
| Mac dev  | `<repo>/.data/dev/studio.sqlite` (+ `artwork/`) — `pnpm demo:reset` wipes and reseeds |
| Electron | `app.getPath('userData')/data` (Windows: `%APPDATA%\HQPlayer Studio\data`)            |
| Probe    | report JSON next to `hqp-probe.exe` (fallback: Desktop, then temp)                    |
