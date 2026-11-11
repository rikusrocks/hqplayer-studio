/**
 * A stand-in for NetEase Cloud Music's web interface, for tests. It follows the rules of the real
 * one (compared with the live service on 2026-11-11) — in particular the version rule that an
 * earlier fake left out, which let a broken request pass every test:
 *
 *  - `/api/search/get` answers `{ code: 200, result: { songs } }`;
 *  - `/api/song/lyric` sends `lrc.lyric` only when the lyrics are NEWER than the version the
 *    caller says it already has (`lv`); otherwise the version comes back with an empty text.
 *    Lyrics start at version 1 and only go up when somebody revises them;
 *  - instrumentals carry `pureMusic: true` and a placeholder line; songs nobody added lyrics to
 *    carry `uncollected: true` or nothing but credit lines.
 *
 * Every catalogue entry and lyric line a test puts in is invented.
 */
export interface FakeNeteaseSong {
  id: number;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  /** Lyric text as stored; leave out for a song nobody added lyrics to (`uncollected`). */
  lyric?: string;
  /** 1 (the default) until the lyrics are revised. */
  lyricVersion?: number;
  pureMusic?: boolean;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  });

export function fakeNetease(songs: FakeNeteaseSong[]) {
  const calls: URL[] = [];

  const search = (url: URL): Response => {
    const words = (url.searchParams.get('s') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Number(url.searchParams.get('limit') ?? '30');
    const hits = songs.filter((s) => {
      const text = `${s.name} ${s.artists.join(' ')}`.toLowerCase();
      return words.some((w) => text.includes(w));
    });
    return json({
      result: {
        songs: hits.slice(0, limit).map((s) => ({
          id: s.id,
          name: s.name,
          artists: s.artists.map((name, i) => ({ id: i + 1, name })),
          album: { id: 1, name: s.album ?? '' },
          duration: s.durationMs ?? 0,
          fee: 0,
          status: 0,
        })),
        hasMore: false,
        songCount: hits.length,
      },
      code: 200,
    });
  };

  const lyric = (url: URL): Response => {
    const song = songs.find((s) => String(s.id) === url.searchParams.get('id'));
    const base = { sgc: false, sfy: false, qfy: false };
    if (!song || song.lyric === undefined) {
      return json({
        ...base,
        uncollected: true,
        sgc: true,
        lrc: { version: 1, lyric: '' },
        code: 200,
      });
    }
    const version = song.lyricVersion ?? 1;
    const have = Number(url.searchParams.get('lv') ?? '0');
    return json({
      ...base,
      ...(song.pureMusic ? { pureMusic: true } : {}),
      lrc: { version, lyric: version > have ? song.lyric : '' },
      klyric: { version: 0, lyric: '' },
      tlyric: { version: 0, lyric: '' },
      code: 200,
    });
  };

  const fetchFn = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/api/search/get') return search(url);
    if (url.pathname === '/api/song/lyric') return lyric(url);
    return json({ code: 404 }, 404);
  }) as typeof fetch;

  return { calls, fetch: fetchFn };
}
