# Third-party notices

HQPlayer Studio is an independent, third-party client. It is **not affiliated with, endorsed by or supported by Signalyst**. "HQPlayer" is a product of Signalyst (Jussi Laako).

## HQPlayer Control API SDK (protocol reference)

The HQPlayer control protocol implementation in `packages/hqplayer-adapter/src/protocol/` is an independent TypeScript implementation. Its command registry, message framing and attribute names were derived from the official SDK source "hqp-control-601-src" (engine 6.0.1), which is distributed under the following licence. The SDK source itself is not included in this repository.

```
HQPlayer Control

Copyright (C) 2011 - 2026 Jussi Laako.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Runtime dependencies (bundled)

| Package                                      | Licence                                      |
| -------------------------------------------- | -------------------------------------------- |
| Electron (Chromium, Node.js)                 | MIT (+ Chromium licences shipped in the app) |
| fastify, @fastify/static, @fastify/websocket | MIT                                          |
| music-metadata                               | MIT                                          |
| zod                                          | MIT                                          |
| uqr (QR code for remote pairing)             | MIT                                          |
| react, react-dom                             | MIT                                          |
| ws                                           | MIT                                          |

Bundled-dependency licence comments are emitted by esbuild to `apps/desktop/dist/main/main.mjs.LEGAL.txt` at build time. A full licence audit is a Phase 5 release task.

## Online services (all opt-in, off by default)

Studio contacts these third-party services only after the user switches them on in Settings; none of them is affiliated with this project.

| Service                             | Used for                  | Interface                                   |
| ----------------------------------- | ------------------------- | ------------------------------------------- |
| LRCLIB (lrclib.net)                 | lyrics                    | documented public API                       |
| lyrics.ovh                          | plain lyrics              | documented public API                       |
| NetEase Cloud Music (music.163.com) | lyrics                    | the web player's interface — not documented |
| Kugou Music (lyrics.kugou.com)      | lyrics                    | the player's interface — not documented     |
| iTunes Search API (Apple)           | album covers              | documented public API                       |
| Deezer API                          | album covers              | documented public API                       |
| MusicBrainz + Cover Art Archive     | album check, album covers | documented public API, open data            |

Lyrics and cover images belong to their respective owners; Studio stores what it fetched on the user's computer only and never redistributes it. No lyrics or cover images are part of this repository.

## Demo content

All demo artists, albums, track titles and lyrics in `fixtures/` and tests are fictional and written for this project. Demo cover art is generated procedurally at runtime.
