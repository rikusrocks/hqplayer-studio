import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary, type LibraryContext } from '../index';
import { NotFoundError, ValidationError } from '../errors';
import { seedDemoLibrary } from '../seed/demo-seed';

let dir: string;
let ctx: LibraryContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-lib-'));
  ctx = openLibrary(dir);
  seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork, 1_700_000_000_000);
});

afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('demo seed + library queries', () => {
  it('seeds the fictional library idempotently', () => {
    const stats = ctx.library.stats();
    expect(stats.albumCount).toBe(13);
    expect(stats.trackCount).toBeGreaterThan(80);
    expect(seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork).skipped).toBe(true);
    expect(ctx.library.stats().trackCount).toBe(stats.trackCount);
  });

  it('keeps same-titled releases as separate albums', () => {
    const page = ctx.library.listAlbums({ q: 'northern lights' });
    expect(page.total).toBe(2);
    expect(page.items.map((a) => a.formatLabel).sort()).toEqual(['DSD256', 'FLAC 24/96']);
  });

  it('searches CJK titles with kana folding and bracket stripping', () => {
    expect(ctx.library.listTracks({ q: 'ねおん' }).items.map((t) => t.title)).toEqual([
      'ネオンの海',
    ]);
    expect(ctx.library.listTracks({ q: 'ひかり' }).items[0]?.title).toBe('「ひかり」をさがして');
    expect(ctx.library.listAlbums({ q: '林夏' }).items[0]?.title).toBe('城市漫游者');
    expect(ctx.library.listTracks({ q: 'smoke mirrors' }).total).toBe(1);
    expect(ctx.library.listTracks({ q: '100%_' }).total).toBe(0);
  });

  it('orders multi-disc albums by disc then track', () => {
    const album = ctx.library.listAlbums({ q: 'quiet theme' }).items[0];
    const detail = ctx.library.getAlbum(album!.id);
    expect(detail.discCount).toBe(2);
    expect(detail.tracks.map((t) => `${t.discNumber}.${t.trackNumber}`).slice(4, 8)).toEqual([
      '1.5',
      '1.6',
      '2.1',
      '2.2',
    ]);
    expect(detail.tracks.every((t) => !('sourcePath' in t))).toBe(true);
  });

  it('filters tracks by artist, including compilation credits', () => {
    const helix = ctx.library.listArtists({ q: 'helix fields' }).items[0]!;
    const tracks = ctx.library.listTracks({ artistId: helix.id, limit: 100 }).items;
    expect(tracks.map((t) => t.title)).toContain('Empty Carriage'); // on "Various Artists"
    expect(tracks.filter((t) => t.album === 'Glass Architecture')).toHaveLength(7);
    const album = ctx.library.listAlbums({ q: 'glass architecture' }).items[0]!;
    expect(album.albumArtistId).toBe(helix.id);
  });

  it('lists artists and folders', () => {
    const artists = ctx.library.listArtists();
    expect(artists.items.find((a) => a.name === 'Various Artists')?.albumCount).toBe(1);
    const roots = ctx.library.listFolders(undefined);
    expect(roots.folders).toHaveLength(1);
    const top = ctx.library.listFolders(roots.folders[0]!.rootId, '');
    expect(top.folders.length).toBe(13);
    const multi = top.folders.find((f) => f.name.includes('Quiet Theme'))!;
    const inside = ctx.library.listFolders(multi.rootId, multi.path);
    expect(inside.folders.map((f) => f.name)).toEqual(['CD1', 'CD2']);
    expect(ctx.library.listFolders(multi.rootId, `${multi.path}/../..`).path).toBe(multi.path);
  });

  it('maps engine-reported paths back to library tracks', () => {
    const t = ctx.library.listTracks({ q: 'polar dawn' }).items[0]!;
    const src = ctx.library.getTrackSources([t.id])[0]!;
    expect(ctx.library.findTrackIdBySource(src.sourcePath.toUpperCase())).toBe(t.id);
    expect(ctx.library.findTrackIdBySource('file:///D:/nope.flac')).toBeNull();
    // HQPlayer 6.1.0 reports "file:" + raw Windows path (observed 2026-11-10)
    expect(ctx.library.findTrackIdBySource(`file:${src.sourcePath}`)).toBe(t.id);
  });
});

describe('PlaylistRepository', () => {
  it('creates, renames, allows duplicates, reorders, removes and duplicates', () => {
    const tracks = ctx.library.listTracks({ limit: 3 }).items.map((t) => t.id);
    const pl = ctx.playlists.create({ name: '  My list ', trackIds: [tracks[0]!, tracks[1]!] });
    expect(pl.name).toBe('My list');

    const withDup = ctx.playlists.addItems(pl.id, [tracks[0]!, tracks[2]!], 1);
    expect(withDup.items.map((i) => i.track.id)).toEqual([
      tracks[0],
      tracks[0],
      tracks[2],
      tracks[1],
    ]);
    expect(new Set(withDup.items.map((i) => i.itemId)).size).toBe(4);

    const reversed = [...withDup.items].reverse().map((i) => i.itemId);
    const reordered = ctx.playlists.reorder(pl.id, reversed);
    expect(reordered.items.map((i) => i.itemId)).toEqual(reversed);
    expect(reordered.items.map((i) => i.position)).toEqual([0, 1, 2, 3]);

    expect(() => ctx.playlists.reorder(pl.id, reversed.slice(1))).toThrow(ValidationError);

    const removed = ctx.playlists.removeItems(pl.id, [reversed[0]!]);
    expect(removed.items).toHaveLength(3);
    expect(removed.items.map((i) => i.position)).toEqual([0, 1, 2]);

    const renamed = ctx.playlists.update(pl.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');

    const copy = ctx.playlists.duplicate(pl.id);
    expect(copy.name).toBe('Renamed (copy)');
    expect(copy.items.map((i) => i.track.id)).toEqual(removed.items.map((i) => i.track.id));

    ctx.playlists.delete(pl.id);
    expect(() => ctx.playlists.get(pl.id)).toThrow(NotFoundError);
    expect(ctx.playlists.get(copy.id).items).toHaveLength(3); // copy is independent
  });

  it('rejects unknown tracks and empty names', () => {
    expect(() => ctx.playlists.create({ name: 'x', trackIds: ['t_missing'] })).toThrow(
      NotFoundError,
    );
    expect(() => ctx.playlists.create({ name: '   ' })).toThrow(ValidationError);
  });

  it('seeded demo playlists include an intentional duplicate', () => {
    const showcase = ctx.playlists.list().find((p) => p.name === 'Hi-Res Showcase')!;
    const detail = ctx.playlists.get(showcase.id);
    expect(detail.items[0]!.track.id).toBe(detail.items[3]!.track.id);
    expect(showcase.artworkIds.length).toBeGreaterThan(0);
  });

  it('persists playlists and queue snapshots across restarts', () => {
    const tracks = ctx.library.listTracks({ limit: 2 }).items.map((t) => t.id);
    const pl = ctx.playlists.create({ name: 'Persist me', trackIds: tracks });
    ctx.queue.save({
      sessionId: 'qs_1',
      version: 3,
      mode: 'album',
      source: { kind: 'album', id: 'al_x', label: 'X' },
      currentIndex: 1,
      items: tracks.map((trackId, i) => ({ itemId: `qi_${i}`, trackId })),
      updatedAt: 1,
    });
    ctx.close();
    ctx = openLibrary(dir);
    expect(ctx.playlists.get(pl.id).items.map((i) => i.track.id)).toEqual(tracks);
    const q = ctx.queue.load();
    expect(q?.version).toBe(3);
    expect(q?.items.map((i) => i.trackId)).toEqual(tracks);
    expect(q?.source?.label).toBe('X');
  });
});

describe('data safety', () => {
  it('cannot delete a track that a playlist references (offline != deleted)', () => {
    const t = ctx.library.listTracks({ limit: 1 }).items[0]!;
    ctx.playlists.create({ name: 'guard', trackIds: [t.id] });
    expect(() => ctx.db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id)).toThrow(
      /FOREIGN KEY/,
    );
  });
});
