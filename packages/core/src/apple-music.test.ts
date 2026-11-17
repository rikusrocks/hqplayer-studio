import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppleMusicState, QueueState, StudioEvent, TrackLyrics } from '@hqps/contracts';
import type { OnlineLyricsProvider, OnlineLyricsQuery } from '@hqps/lyrics';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioServer, type StudioServer } from './server';
import {
  cleanError,
  looksLikeVirtualCable,
  parseArtwork,
  parseInspect,
  parseSessions,
  parseWatchLine,
  SimulatedMedia,
  sniffImageMime,
  windowsMedia,
  type MediaAction,
  type MediaSession,
  type SystemAudioInfo,
  type WindowsMedia,
} from './services/windows-media';

const APPLE = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

/** A scriptable stand-in for Windows: one Apple Music session the test can change. */
class FakeMedia implements WindowsMedia {
  readonly supported = true;
  readonly simulated = false;
  calls: string[] = [];
  watching = false;
  failControl = false;
  /** What reading the cover does: a picture, nothing published, or a failure. */
  cover: 'ok' | 'none' | 'fail' = 'ok';
  session: MediaSession | null = {
    app: APPLE,
    status: 'Playing',
    title: 'Private Title',
    artist: 'Private Artist',
    album: 'Private Album',
    hasThumbnail: true,
    positionMs: 30_000,
    positionAt: Date.now(),
    durationMs: 200_000,
    controls: { play: true, pause: true, next: true, previous: true },
  };
  info: SystemAudioInfo = {
    devices: ['CABLE Input (VB-Audio Virtual Cable)', 'Speakers (Realtek Audio)'],
    microphoneAccess: 'allow',
    appleMusic: { installed: true, running: true, familyName: 'AppleInc.AppleMusicWin_x' },
    errors: [],
  };
  private onChange: ((sessions: MediaSession[]) => void) | null = null;

  emit(): void {
    this.onChange?.(this.session ? [{ ...this.session }, other()] : [other()]);
  }
  watch(onChange: (sessions: MediaSession[]) => void, onError: (m: string | null) => void) {
    this.watching = true;
    this.onChange = onChange;
    onError(null);
    this.emit();
    return () => {
      this.watching = false;
      this.onChange = null;
    };
  }
  async control(app: string, action: MediaAction): Promise<boolean> {
    this.calls.push(`${action}:${app}`);
    if (this.failControl) return false;
    if (this.session && (action === 'play' || action === 'pause')) {
      this.session.status = action === 'play' ? 'Playing' : 'Paused';
    }
    if (this.session && action === 'next') this.session.title = 'Next Private Title';
    this.emit();
    return true;
  }
  async artwork() {
    if (this.cover === 'fail') throw new Error('reflect: Cannot convert; as-stream: nope');
    return this.cover === 'none' ? null : { data: PNG, mime: 'image/png' };
  }
  async inspect() {
    return this.info;
  }
  async open(target: string) {
    this.calls.push(`open:${target}`);
  }
}

const other = (): MediaSession => ({
  app: 'Spotify.exe',
  status: 'Paused',
  title: 'Someone Else',
  artist: '',
  album: '',
  hasThumbnail: false,
  positionMs: null,
  positionAt: null,
  durationMs: null,
  controls: { play: true, pause: true, next: false, previous: false },
});

let dir: string;
let ctx: LibraryContext;
let adapter: MockHQPlayerAdapter;
let server: StudioServer;
let media: FakeMedia;
let events: StudioEvent[];

const HOOK_TIMEOUT_MS = 30_000;
const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:47321' };

async function api<T = unknown>(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: method === 'GET' ? { host: '127.0.0.1:47321' } : JSON_HEADERS,
    payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
    remoteAddress: '127.0.0.1',
  });
  const type = String(res.headers['content-type'] ?? '');
  return {
    status: res.statusCode,
    body: (type.includes('json') ? res.json() : res.rawPayload) as T,
    type,
  };
}

async function boot(liveInputs?: string[], providers?: OnlineLyricsProvider[]) {
  booted = true;
  dir = mkdtempSync(join(tmpdir(), 'hqps-am-'));
  ctx = openLibrary(dir);
  seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
  adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 40, liveInputs });
  media = new FakeMedia();
  server = await createStudioServer({
    adapter,
    ctx,
    appVersion: 'test',
    port: 0,
    demoMode: true,
    engine: { commandTimeoutMs: 500, reconnectMinMs: 20, reconnectMaxMs: 50 },
    queue: { settleMs: 0 },
    appleMusic: { media },
    ...(providers ? { lyrics: { providers } } : {}),
  });
  events = [];
  server.hub.subscribe((e) => events.push(e));
  await server.engine.start();
}

let booted = false;

afterEach(async () => {
  if (!booted) return; // the helper tests below start no server
  booted = false;
  await server.close();
  adapter.dispose();
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
}, HOOK_TIMEOUT_MS);

const enable = () => api<AppleMusicState>('POST', '/apple-music/settings', { enabled: true });
const status = () => server.engine.getStatus();

/** Play the first demo album from the library and return the queue. */
async function playAlbum(): Promise<QueueState> {
  const albums = await api<{ items: { id: string }[] }>('GET', '/library/albums?sort=year');
  const album = await api<{ tracks: { id: string }[] }>(
    'GET',
    `/library/albums/${albums.body.items[0]!.id}`,
  );
  const r = await api<QueueState>('POST', '/queue/replace', {
    trackIds: album.body.tracks.slice(0, 3).map((t) => t.id),
  });
  expect(r.status).toBe(200);
  return r.body;
}

describe('Apple Music through a live input', () => {
  it(
    'is off until the user turns it on, and then watches Windows',
    { timeout: 20_000 },
    async () => {
      await boot();
      const before = await api<AppleMusicState>('GET', '/apple-music');
      expect(before.body).toMatchObject({ enabled: false, phase: 'idle', blocked: 'disabled' });
      expect(before.body.nowPlaying).toBeNull();
      expect(media.watching).toBe(false);
      expect((await api('POST', '/apple-music/start')).status).toBe(409);
      expect(status().track).toBeNull();

      const on = await enable();
      expect(on.body).toMatchObject({ enabled: true, blocked: null, supported: true });
      expect(media.watching).toBe(true);
      // the Apple Music session is picked out of everything Windows lists
      expect(on.body.nowPlaying).toMatchObject({
        app: APPLE,
        playback: 'playing',
        title: 'Private Title',
      });
      // …and survives a restart of the service
      expect(ctx.settings.get('appleMusic.enabled', false)).toBe(true);

      const off = await api<AppleMusicState>('POST', '/apple-music/settings', { enabled: false });
      expect(off.body).toMatchObject({ enabled: false, nowPlaying: null });
      expect(media.watching).toBe(false);
    },
  );

  it(
    'switches HQPlayer to the live input and shows what Apple Music plays',
    { timeout: 20_000 },
    async () => {
      await boot();
      await enable();
      const queue = await playAlbum();
      await vi.waitFor(() => expect(status().transport).toBe('playing'));

      const started = await api<AppleMusicState>('POST', '/apple-music/start');
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ phase: 'active', liveUri: 'audio:default/0/2' });
      expect(started.body.lastStart).toMatchObject({ ok: true });
      expect(started.body.lastStart?.attempts.at(-1)).toMatchObject({
        uri: 'audio:default/0/2',
        reachedPlaying: true,
      });
      // HQPlayer's playlist is the one live entry…
      expect((await adapter.getEngineQueue()).entries.map((e) => e.uri)).toEqual([
        'audio:default/0/2',
      ]);
      // …and the status Studio publishes describes the song, not the stream
      await vi.waitFor(() => expect(status().track?.artworkId).toMatch(/^live-apple-music-\d+$/));
      const s = status();
      expect(s.transport).toBe('playing');
      expect(s.track).toMatchObject({
        source: 'apple-music',
        title: 'Private Title',
        artist: 'Private Artist',
        album: 'Private Album',
        studioTrackId: null,
      });
      expect(s.durationMs).toBe(200_000);
      expect(s.positionMs).toBeGreaterThanOrEqual(30_000);
      // the cover is served like any other artwork
      const art = await api<Buffer>('GET', `/artwork/${s.track!.artworkId}`);
      expect(art.status).toBe(200);
      expect(art.type).toContain('image/png');
      expect(Buffer.compare(art.body, PNG)).toBe(0);
      // Studio's queue is kept, flagged as waiting, and not called out of sync
      const q = (await api<QueueState>('GET', '/queue')).body;
      expect(q.items.map((i) => i.track.id)).toEqual(queue.items.map((i) => i.track.id));
      expect(q.sync).toMatchObject({ state: 'unknown', code: 'live_input' });
      expect(ctx.settings.get('appleMusic.lastUri', null)).toBe('audio:default/0/2');
    },
  );

  it(
    'sends the transport buttons to Apple Music, not to HQPlayer',
    { timeout: 20_000 },
    async () => {
      await boot();
      await enable();
      await api('POST', '/apple-music/start');

      expect((await api('POST', '/engine/transport', { action: 'pause' })).status).toBe(200);
      expect(media.calls).toEqual([`pause:${APPLE}`]);
      // HQPlayer keeps the input open; what the user sees is Apple Music's state
      expect((await adapter.getStatus()).transport).toBe('playing');
      await vi.waitFor(() => expect(status().transport).toBe('paused'));

      await api('POST', '/engine/transport', { action: 'toggle' });
      await api('POST', '/engine/transport', { action: 'next' });
      await api('POST', '/apple-music/control', { action: 'previous' });
      expect(media.calls).toEqual([
        `pause:${APPLE}`,
        `play:${APPLE}`,
        `next:${APPLE}`,
        `previous:${APPLE}`,
      ]);
      await vi.waitFor(() => expect(status().track?.title).toBe('Next Private Title'));

      const seek = await api('POST', '/engine/seek', { positionMs: 1000 });
      expect(seek.status).toBeGreaterThanOrEqual(400);

      media.failControl = true;
      expect((await api('POST', '/apple-music/control', { action: 'next' })).status).toBe(409);
    },
  );

  it('puts the library queue back on Stop, without playing it', { timeout: 20_000 }, async () => {
    await boot();
    await enable();
    const queue = await playAlbum();
    await api('POST', '/apple-music/start');

    const stopped = await api<AppleMusicState>('POST', '/apple-music/stop');
    expect(stopped.body.phase).toBe('idle');
    // Apple Music is paused so it does not keep playing into the cable
    expect(media.calls).toContain(`pause:${APPLE}`);
    const engineQueue = await adapter.getEngineQueue();
    expect(engineQueue.entries).toHaveLength(queue.items.length);
    expect(engineQueue.entries.some((e) => e.uri?.startsWith('audio:'))).toBe(false);
    expect((await adapter.getStatus()).transport).toBe('stopped');
    await vi.waitFor(async () =>
      expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('in_sync'),
    );
    expect(status().track?.source ?? null).toBeNull();
  });

  it('ends by itself when something from the library is played', { timeout: 20_000 }, async () => {
    await boot();
    await enable();
    await api('POST', '/apple-music/start');
    // appending to a playlist that is one live input makes no sense: refused
    const albums = await api<{ items: { id: string }[] }>('GET', '/library/albums?sort=year');
    const album = await api<{ tracks: { id: string }[] }>(
      'GET',
      `/library/albums/${albums.body.items[0]!.id}`,
    );
    const add = await api('POST', '/queue/add', {
      trackIds: [album.body.tracks[0]!.id],
      position: 'end',
    });
    expect(add.status).toBe(409);
    expect((await api<AppleMusicState>('GET', '/apple-music')).body.phase).toBe('active');

    await playAlbum();
    expect((await api<AppleMusicState>('GET', '/apple-music')).body.phase).toBe('idle');
    await vi.waitFor(() => expect(status().track?.studioTrackId).toBeTruthy());
    expect(status().track?.source ?? null).toBeNull();
    expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('in_sync');
    // the transport buttons are HQPlayer's again
    media.calls = [];
    await api('POST', '/engine/transport', { action: 'pause' });
    expect(media.calls).toEqual([]);
    expect((await adapter.getStatus()).transport).toBe('paused');
  });

  it(
    'reports what HQPlayer answered when no live input opens, and restores the queue',
    { timeout: 20_000 },
    async () => {
      await boot([]);
      await enable();
      const queue = await playAlbum();

      const failed = await api<AppleMusicState>('POST', '/apple-music/start');
      expect(failed.status).toBe(200);
      expect(failed.body.phase).toBe('idle');
      expect(failed.body.lastStart).toMatchObject({ ok: false });
      expect(failed.body.lastStart?.attempts.map((a) => a.uri)).toEqual([
        'audio:default/0/2',
        'audio:default/44100/2',
        'audio:default/48000/2',
      ]);
      expect(failed.body.lastStart?.attempts.every((a) => a.error)).toBe(true);
      expect(events.some((e) => e.type === 'notice' && e.code === 'applemusic_start_failed')).toBe(
        true,
      );
      expect((await adapter.getEngineQueue()).entries).toHaveLength(queue.items.length);
      expect(status().track?.source ?? null).toBeNull();
    },
  );

  it('tries the user’s own address first', { timeout: 20_000 }, async () => {
    await boot(['audio:cable/48000/2']);
    await enable();
    expect(
      (await api('POST', '/apple-music/settings', { preferredUri: 'D:\\x.flac' })).status,
    ).toBe(400);
    const saved = await api<AppleMusicState>('POST', '/apple-music/settings', {
      preferredUri: 'audio:cable/48000/2',
    });
    expect(saved.body.preferredUri).toBe('audio:cable/48000/2');
    const started = await api<AppleMusicState>('POST', '/apple-music/start');
    expect(started.body).toMatchObject({ phase: 'active', liveUri: 'audio:cable/48000/2' });
    expect(started.body.lastStart?.attempts).toHaveLength(1);
  });

  it('checks the PC without changing anything', { timeout: 20_000 }, async () => {
    await boot();
    await enable();
    const before = adapter.getStatus();
    const checked = await api<AppleMusicState>('POST', '/apple-music/check');
    const byId = Object.fromEntries(checked.body.setup!.checks.map((c) => [c.id, c]));
    expect(byId.windows).toMatchObject({ status: 'ok' });
    expect(byId.engine).toMatchObject({ status: 'ok' });
    expect(byId.appleMusicApp).toMatchObject({ status: 'ok' });
    expect(byId.virtualCable).toMatchObject({
      status: 'ok',
      detail: 'CABLE Input (VB-Audio Virtual Cable)',
    });
    expect(byId.microphoneAccess).toMatchObject({ status: 'ok' });
    expect(byId.cableFormat).toMatchObject({ status: 'manual' });
    expect(byId.appRouting).toMatchObject({ status: 'manual' });
    expect(byId.hqplayerInput?.detail).toContain('audio:default/0/2');
    expect(checked.body.setup!.listedInputs).toEqual(['audio:default/0/2']);
    // the mock reports the rate it plays at, not which list entry is selected
    expect(byId.outputRate?.status).toBe('manual');
    expect(byId.outputRate?.detail).toMatch(/MHz$/);
    expect(byId.liveInputAddress).toMatchObject({ status: 'manual', detail: null });
    expect((await adapter.getStatus()).transport).toBe((await before).transport);

    media.session = null;
    media.emit();
    media.info = {
      devices: ['Speakers (Realtek Audio)'],
      microphoneAccess: 'deny',
      appleMusic: { installed: true, running: false, familyName: null },
      errors: [],
    };
    const again = await api<AppleMusicState>('POST', '/apple-music/check');
    const next = Object.fromEntries(again.body.setup!.checks.map((c) => [c.id, c]));
    expect(next.appleMusicApp).toMatchObject({ status: 'missing', detail: 'not_running' });
    expect(next.virtualCable).toMatchObject({ status: 'missing' });
    expect(next.microphoneAccess).toMatchObject({ status: 'missing' });

    // a saved address shows up in the last check at once
    const saved = await api<AppleMusicState>('POST', '/apple-music/settings', {
      preferredUri: 'audio:default/48000/2',
    });
    expect(saved.body.setup!.checks.find((c) => c.id === 'liveInputAddress')).toMatchObject({
      status: 'ok',
      detail: 'audio:default/48000/2',
    });

    // HQPlayer's output rate on Auto (rate 0) is flagged; a fixed rate passes
    const real = adapter.getDspState.bind(adapter);
    const withRate = (rate: number) =>
      vi.spyOn(adapter, 'getDspState').mockImplementation(async () => ({
        ...(await real()),
        rates: [
          { index: 0, rate: 0 },
          { index: 1, rate: 705600 },
        ],
        selected: {
          mode: null,
          filter1x: null,
          filterNx: null,
          shaper: null,
          rate,
          invert: null,
          adaptiveVolume: null,
          convolution: null,
        },
      }));
    withRate(0);
    const auto = await api<AppleMusicState>('POST', '/apple-music/check');
    expect(auto.body.setup!.checks.find((c) => c.id === 'outputRate')).toMatchObject({
      status: 'missing',
      detail: 'rate_auto',
    });
    withRate(1);
    const fixed = await api<AppleMusicState>('POST', '/apple-music/check');
    expect(fixed.body.setup!.checks.find((c) => c.id === 'outputRate')).toMatchObject({
      status: 'ok',
      detail: '705.6 kHz',
    });
    vi.restoreAllMocks();

    expect((await api('POST', '/apple-music/open', { target: 'app-volume' })).status).toBe(200);
    expect(media.calls).toContain('open:app-volume');
    expect((await api('POST', '/apple-music/open', { target: 'cmd.exe' })).status).toBe(400);
  });

  it('picks up a live input that HQPlayer is already playing', { timeout: 20_000 }, async () => {
    await boot();
    await enable();
    // started outside Studio (or before Studio was restarted)
    await adapter.playLiveInput(['audio:default/0/2']);
    await vi.waitFor(async () =>
      expect((await api<AppleMusicState>('GET', '/apple-music')).body.phase).toBe('active'),
    );
    await vi.waitFor(() => expect(status().track?.source).toBe('apple-music'));
    expect((await api<QueueState>('GET', '/queue')).body.sync.code).toBe('live_input');
  });

  it(
    'says why there is no cover, and falls back to an online one when that is turned on',
    { timeout: 20_000 },
    async () => {
      await boot();
      media.cover = 'fail';
      const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0]);
      const asked: string[] = [];
      let online = false;
      server.appleMusic.setCoverLookup({
        enabled: () => online,
        async find(album, artist) {
          asked.push(`${album}|${artist}`);
          return album === 'Private Album' ? { bytes: JPEG, mime: 'image/jpeg' } : null;
        },
      });
      await enable();
      await api('POST', '/apple-music/start');

      // Windows has a cover but will not hand it over: the reason is on the page, not swallowed
      await vi.waitFor(async () =>
        expect((await api<AppleMusicState>('GET', '/apple-music')).body.artwork.error).toContain(
          'Cannot convert',
        ),
      );
      let state = (await api<AppleMusicState>('GET', '/apple-music')).body;
      expect(state.artwork).toMatchObject({ source: null, onlineEnabled: false });
      expect(state.nowPlaying?.hasArtwork).toBe(false);
      expect(status().track?.artworkId ?? null).toBeNull();
      expect(asked).toEqual([]); // online covers are off: nothing is sent

      // with online covers on, the next song gets its cover from there
      online = true;
      media.session!.title = 'Another Private Title';
      media.emit();
      await vi.waitFor(() => expect(status().track?.artworkId).toMatch(/^live-apple-music-\d+$/));
      state = (await api<AppleMusicState>('GET', '/apple-music')).body;
      expect(state.artwork).toMatchObject({ source: 'online', onlineEnabled: true });
      expect(state.artwork.error).toContain('Cannot convert'); // still reported
      const art = await api<Buffer>('GET', `/artwork/${status().track!.artworkId}`);
      expect(art.type).toContain('image/jpeg');
      expect(asked).toEqual(['Private Album|Private Artist']);

      // same album again: not asked twice
      media.session!.title = 'Third Private Title';
      media.emit();
      await vi.waitFor(() => expect(status().track?.title).toBe('Third Private Title'));
      await new Promise((r) => setTimeout(r, 50));
      expect(asked).toHaveLength(1);

      // once Windows does hand over a cover, that one wins and the error goes away
      media.cover = 'ok';
      media.session!.album = 'Other Private Album';
      media.emit();
      await vi.waitFor(async () =>
        expect((await api<AppleMusicState>('GET', '/apple-music')).body.artwork).toMatchObject({
          source: 'windows',
          error: null,
        }),
      );
    },
  );

  it('lists the songs played since Start instead of a queue', { timeout: 20_000 }, async () => {
    await boot();
    await enable();
    expect((await api<AppleMusicState>('GET', '/apple-music')).body.history).toEqual([]);
    await api('POST', '/apple-music/start');
    const first = (await api<AppleMusicState>('GET', '/apple-music')).body.history;
    expect(first.map((h) => h.title)).toEqual(['Private Title']);

    await api('POST', '/engine/transport', { action: 'next' });
    // pausing or a cover arriving is not a new song
    await api('POST', '/engine/transport', { action: 'pause' });
    const second = (await api<AppleMusicState>('GET', '/apple-music')).body.history;
    expect(second.map((h) => h.title)).toEqual(['Private Title', 'Next Private Title']);
    expect(second[1]).toMatchObject({ artist: 'Private Artist', album: 'Private Album' });

    // it is this session's list only: gone after Stop, and never written to the database
    await api('POST', '/apple-music/stop');
    expect((await api<AppleMusicState>('GET', '/apple-music')).body.history).toEqual([]);
    expect(JSON.stringify(ctx.settings.get('appleMusic.lastUri', null))).not.toContain('Private');
  });

  it(
    'finds lyrics for the Apple Music song by title and artist, in memory only',
    { timeout: 20_000 },
    async () => {
      const asked: OnlineLyricsQuery[] = [];
      const provider: OnlineLyricsProvider = {
        id: 'netease',
        blockedForMs: () => 0,
        async find(q) {
          asked.push(q);
          return q.trackName === 'Private Title'
            ? {
                synced: '[00:01.00]first line\n[00:05.00]second line',
                plain: null,
                instrumental: false,
              }
            : null;
        },
        async search() {
          return [
            {
              provider: 'netease',
              ref: 'r1',
              trackName: 'Next Private Title',
              artistName: 'Private Artist',
              albumName: '',
              durationSec: null,
              synced: false,
              instrumental: false,
              lyrics: null,
            },
          ];
        },
        async fetch() {
          return { synced: null, plain: 'picked by hand', instrumental: false };
        },
      };
      await boot(undefined, [provider]);
      await api('POST', '/settings/lyrics', { online: true, providers: ['netease'] });
      await enable();

      // nothing is playing through the live input yet
      expect((await api('GET', '/tracks/live-apple-music/lyrics')).status).toBe(404);

      await api('POST', '/apple-music/start');
      const found = await api<TrackLyrics>('GET', '/tracks/live-apple-music/lyrics');
      expect(found.body).toMatchObject({ state: 'found', source: 'netease', kind: 'synced' });
      expect(found.body.lines.map((l) => l.text)).toEqual(['first line', 'second line']);
      expect(asked).toEqual([
        {
          trackName: 'Private Title',
          artistName: 'Private Artist',
          albumName: 'Private Album',
          durationSec: 200,
        },
      ]);
      // asked once per song, calibrated per song
      await api('GET', '/tracks/live-apple-music/lyrics');
      expect(asked).toHaveLength(1);
      const offset = await api<TrackLyrics>('POST', '/tracks/live-apple-music/lyrics/offset', {
        offsetMs: 1500,
      });
      expect(offset.body.offsetMs).toBe(1500);

      // the next song starts over (and lyric views are told to refetch)
      events.length = 0;
      await api('POST', '/engine/transport', { action: 'next' });
      expect(
        events.some((e) => e.type === 'lyrics.changed' && e.trackId === 'live-apple-music'),
      ).toBe(true);
      const next = await api<TrackLyrics>('GET', '/tracks/live-apple-music/lyrics');
      expect(next.body).toMatchObject({ state: 'not_found', offsetMs: 0 });
      // manual matching works like for a library track
      const picked = await api<TrackLyrics>('POST', '/tracks/live-apple-music/lyrics/select', {
        provider: 'netease',
        ref: 'r1',
      });
      expect(picked.body).toMatchObject({ state: 'found', kind: 'plain', selectedByUser: true });

      // going back to the first song brings its lyrics and calibration back without asking again
      await api('POST', '/apple-music/control', { action: 'previous' });
      media.session!.title = 'Private Title';
      media.emit();
      const back = await api<TrackLyrics>('GET', '/tracks/live-apple-music/lyrics');
      expect(back.body).toMatchObject({ state: 'found', kind: 'synced', offsetMs: 1500 });
      expect(asked.filter((q) => q.trackName === 'Private Title')).toHaveLength(1);

      // nothing about the live songs is stored in the database
      expect(ctx.lyrics.get('live-apple-music')).toBeNull();
      expect(ctx.lyrics.counts().netease ?? 0).toBe(0);
    },
  );

  it(
    'does not ask a lyrics site unless online lyrics are turned on',
    { timeout: 20_000 },
    async () => {
      let asked = 0;
      const provider: OnlineLyricsProvider = {
        id: 'netease',
        blockedForMs: () => 0,
        async find() {
          asked += 1;
          return null;
        },
        async search() {
          return [];
        },
        async fetch() {
          return null;
        },
      };
      await boot(undefined, [provider]);
      await enable();
      await api('POST', '/apple-music/start');
      const res = await api<TrackLyrics>('GET', '/tracks/live-apple-music/lyrics');
      expect(res.body).toMatchObject({ state: 'not_found', online: { enabled: false } });
      expect(asked).toBe(0);
    },
  );

  it('keeps the simulated source clearly marked', { timeout: 20_000 }, async () => {
    booted = true;
    dir = mkdtempSync(join(tmpdir(), 'hqps-am-'));
    ctx = openLibrary(dir);
    adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 40 });
    server = await createStudioServer({ adapter, ctx, appVersion: 'test', port: 0 });
    await server.engine.start();
    const state = (await enable()).body;
    expect(state).toMatchObject({ simulated: true, supported: true });
    expect(state.nowPlaying?.title).toBe('Paper Lanterns');
  });
});

describe('Windows media helpers', () => {
  it('parses sessions and tolerates odd shapes', () => {
    const one = parseSessions({
      app: APPLE,
      status: 'Playing',
      title: 'T',
      artist: 'A',
      album: 'B',
      hasThumbnail: true,
      positionMs: 1500,
      positionAt: 1_700_000_000_000,
      durationMs: 200_000,
      controls: { play: true, pause: true, next: false, previous: false },
    });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ app: APPLE, positionMs: 1500, durationMs: 200_000 });
    expect(parseSessions(null)).toEqual([]);
    // no timeline published: Windows reports zero length and a year-1601 timestamp
    expect(
      parseSessions([
        { app: '' },
        { app: 'X', title: 5, durationMs: 0, positionAt: -11_644_473_600_000 },
      ]),
    ).toEqual([
      expect.objectContaining({
        app: 'X',
        title: '',
        positionMs: null,
        positionAt: null,
        durationMs: null,
      }),
    ]);
  });

  it('reads watcher lines: sessions, errors, and junk', () => {
    expect(parseWatchLine('{"sessions":[]}')).toEqual({ sessions: [] });
    expect(parseWatchLine('{"sessions":{"app":"X"}}')).toEqual({
      sessions: [expect.objectContaining({ app: 'X' })],
    });
    expect(parseWatchLine('{"error":"Access is denied"}')).toEqual({ error: 'Access is denied' });
    expect(parseWatchLine('WARNING: something')).toBeNull();
    expect(parseWatchLine('{"sessions":[')).toBeNull();
  });

  it('reads the set-up facts and recognises virtual cables', () => {
    expect(
      parseInspect(
        '{"devices":["CABLE Output (VB-Audio Virtual Cable)","Speakers"],"microphoneAccess":"Allow","appleMusic":{"installed":true,"running":false,"familyName":"AppleInc.AppleMusicWin_x"},"errors":[]}',
      ),
    ).toEqual({
      devices: ['CABLE Output (VB-Audio Virtual Cable)', 'Speakers'],
      microphoneAccess: 'allow',
      appleMusic: { installed: true, running: false, familyName: 'AppleInc.AppleMusicWin_x' },
      errors: [],
    });
    expect(
      parseInspect(
        '{"devices":null,"microphoneAccess":null,"appleMusic":null,"errors":["devices: x"]}',
      ),
    ).toEqual({
      devices: null,
      microphoneAccess: null,
      appleMusic: null,
      errors: ['devices: x'],
    });
    for (const name of [
      'CABLE Input (VB-Audio Virtual Cable)',
      'Hi-Fi Cable Input',
      'VoiceMeeter Input',
    ])
      expect(looksLikeVirtualCable(name)).toBe(true);
    for (const name of ['Speakers (Realtek Audio)', 'AudioByte ASIO', 'Microphone Array'])
      expect(looksLikeVirtualCable(name)).toBe(false);
  });

  it('sniffs cover formats and flattens PowerShell errors', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'image/jpeg',
    );
    expect(sniffImageMime(Buffer.from('not an image at all'))).toBeNull();
    expect(sniffImageMime(Buffer.from('<html>…………</html>'), 'text/html')).toBeNull();
    expect(
      cleanError('#< CLIXML\r\n<Objs><S S="Error">Access is denied_x000D__x000A_</S></Objs>'),
    ).toBe('Access is denied');
    expect(cleanError('')).toBe('Windows PowerShell failed');
  });

  it('reads the cover answer: picture, nothing published, or the reasons it failed', () => {
    const b64 = PNG.toString('base64');
    expect(
      parseArtwork(`{"data":"${b64}","mime":"","how":"reflect","none":false,"errors":[]}`),
    ).toEqual({
      data: PNG,
      mime: 'image/png',
    });
    // a number printed by an earlier step must not break the answer
    expect(
      parseArtwork(
        `15\r\n{"data":"${b64}","mime":"image/png","how":"data-reader","none":false,"errors":["reflect: x"]}\r\n`,
      )?.mime,
    ).toBe('image/png');
    expect(parseArtwork('{"data":null,"none":true,"errors":[]}')).toBeNull();
    expect(() =>
      parseArtwork(
        '{"data":null,"none":false,"errors":["reflect: Cannot convert","as-stream: no overload"]}',
      ),
    ).toThrow('reflect: Cannot convert; as-stream: no overload');
    expect(() =>
      parseArtwork('{"data":"aGVsbG8gd29ybGQhISE=","mime":"text/plain","none":false,"errors":[]}'),
    ).toThrow('not a picture');
    expect(() => parseArtwork('')).toThrow('no answer');
  });

  it('is Windows-only, with a demo for the mock engine', async () => {
    expect(windowsMedia('darwin').supported).toBe(false);
    expect(windowsMedia('win32').supported).toBe(true);
    const demo = new SimulatedMedia();
    let seen: MediaSession[] = [];
    const stop = demo.watch(
      (s) => (seen = s),
      () => undefined,
    );
    expect(seen[0]).toMatchObject({ status: 'Playing', title: 'Paper Lanterns' });
    await demo.control(seen[0]!.app, 'next');
    await demo.control(seen[0]!.app, 'pause');
    expect(seen[0]).toMatchObject({ status: 'Paused', title: 'Slow Tide' });
    expect((await demo.artwork()).mime).toBe('image/svg+xml');
    stop();
  });
});
