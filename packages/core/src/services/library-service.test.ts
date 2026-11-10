import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioEvent } from '@hqps/contracts';
import { openLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWav } from '../../../library/src/testing/synthetic-audio';
import { EventHub } from '../event-hub';
import { LibraryService } from './library-service';

let dir: string;
let music: string;
let ctx: LibraryContext;
let hub: EventHub;
let service: LibraryService | null = null;
const events: StudioEvent[] = [];

const wav = (title: string) => makeWav({ title, artist: 'Watcher', album: 'Watch Album' }, 2);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-watch-'));
  music = join(dir, 'Music');
  mkdirSync(join(music, 'Artist', 'Album One'), { recursive: true });
  writeFileSync(join(music, 'Artist', 'Album One', '01 First.wav'), wav('First'));
  ctx = openLibrary(join(dir, 'data'));
  hub = new EventHub();
  events.length = 0;
  hub.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await service?.stop();
  service = null;
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

const titles = () =>
  ctx.library
    .listTracks({ limit: 100 })
    .items.filter((t) => t.available)
    .map((t) => t.title)
    .sort();

describe('LibraryService automatic updates', () => {
  it('rescans just the changed folders when files appear, and keeps identities on rename', async () => {
    service = new LibraryService(ctx, hub, { watcher: { quietMs: 150, maxWaitMs: 1000 } });
    const root = service.addRoot(music);
    await service.idle();
    service.start();
    expect(service.watchState(root.id)).toBe('active');
    const firstId = ctx.library.listTracks({ q: 'First' }).items[0]!.id;

    mkdirSync(join(music, 'Artist', 'Album Two'));
    writeFileSync(join(music, 'Artist', 'Album Two', '01 Second.wav'), wav('Second'));
    await vi.waitFor(() => expect(titles()).toEqual(['First', 'Second']), {
      timeout: 8000,
      interval: 100,
    });
    const watchJob = service.listJobs().find((j) => j.trigger === 'watch');
    expect(watchJob?.added).toBeGreaterThanOrEqual(1);
    expect(watchJob?.filesSeen).toBeLessThan(2 + 1); // only the changed folder was walked

    renameSync(join(music, 'Artist', 'Album One'), join(music, 'Artist', 'Album One (2024)'));
    await vi.waitFor(
      () => {
        const t = ctx.library.getTrack(firstId);
        expect(t.folder).toBe('Artist/Album One (2024)');
        expect(t.available).toBe(true);
      },
      { timeout: 8000, interval: 100 },
    );
    expect(ctx.library.stats().unavailableTrackCount).toBe(0);
  });

  it('runs the fallback scan when the last full scan is too old', async () => {
    // not watched → the (normally hourly) unwatched interval applies
    service = new LibraryService(ctx, hub, { watch: false, tickMs: 50, rescanUnwatchedAfterMs: 0 });
    service.addRoot(music);
    await service.idle();
    service.start();
    await vi.waitFor(() =>
      expect(service!.listJobs().some((j) => j.trigger === 'schedule')).toBe(true),
    );
    expect(service.watchState(ctx.library.listRoots()[0]!.id)).toBe('off');
  });

  it('paces file reads through the provided hook', async () => {
    const pace = vi.fn(async () => undefined);
    service = new LibraryService(ctx, hub, { watch: false, pace });
    writeFileSync(join(music, 'Artist', 'Album One', '02 Next.wav'), wav('Next'));
    service.addRoot(music);
    await service.idle();
    // two tag reads + one embedded-cover read for the album (no folder image)
    expect(pace).toHaveBeenCalledTimes(3);
    // an automatic rescan: unchanged files are not read, and cover lookups are not retried for
    // albums that did not change
    service.scan(undefined, { trigger: 'watch' });
    await service.idle();
    expect(pace).toHaveBeenCalledTimes(3);
  });

  it('merges automatic requests into a queued job and publishes nothing when nothing changed', async () => {
    service = new LibraryService(ctx, hub, { watch: false });
    const root = service.addRoot(music); // running
    const a = service.scan(root.id, { trigger: 'watch', subtrees: ['Artist/Album One'] });
    const b = service.scan(root.id, { trigger: 'watch', subtrees: ['Artist'] });
    expect(a[0]!.id).toBe(b[0]!.id);
    await service.idle();
    const changedBefore = events.filter((e) => e.type === 'library.changed').length;
    service.scan(root.id, { trigger: 'watch', subtrees: ['Artist/Album One'] });
    await service.idle();
    expect(events.filter((e) => e.type === 'library.changed').length).toBe(changedBefore);
  });
});
