import { watch, type FSWatcher } from 'node:fs';
import { extname } from 'node:path';
import { AUDIO_EXTENSIONS, isIgnoredLibraryPath, type LibraryContext } from '@hqps/library';

export type WatchState = 'active' | 'unavailable' | 'off';

export interface LibraryWatcherOptions {
  /** Wait for this much quiet before rescanning (copying an album fires many events). */
  quietMs?: number;
  /** …but never wait longer than this after the first change. */
  maxWaitMs?: number;
  /** More changed folders than this → rescan the whole root instead. */
  maxSubtrees?: number;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/**
 * Turns file-system events under the library roots into targeted rescans.
 *
 * Uses `fs.watch(root, { recursive: true })` (ReadDirectoryChangesW on Windows, FSEvents on
 * macOS). Network shares may not deliver events, or the watch may fail when a NAS goes away —
 * that state is reported as `unavailable` and the periodic fallback scan covers it.
 * The watcher only ever reads: it never touches music files.
 */
export class LibraryWatcher {
  private readonly watchers = new Map<string, { watcher: FSWatcher; path: string }>();
  private readonly unavailable = new Set<string>();
  private readonly changes = new Map<
    string,
    { dirs: Set<string>; full: boolean; first: number; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly maxSubtrees: number;

  constructor(
    private readonly ctx: LibraryContext,
    /** `subtrees` null = whole root. */
    private readonly onChange: (rootId: string, subtrees: string[] | null) => void,
    options: LibraryWatcherOptions = {},
  ) {
    this.quietMs = options.quietMs ?? 4000;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    this.maxSubtrees = options.maxSubtrees ?? 64;
  }

  /** Start/stop watchers so they match the enabled roots; retries ones that failed. */
  sync(): void {
    const wanted = new Map(
      this.ctx.library
        .listRoots()
        .filter((r) => r.enabled && r.kind !== 'fixture')
        .map((r) => [r.id, r.path]),
    );
    for (const [id, entry] of this.watchers) {
      if (wanted.get(id) !== entry.path) this.close(id);
    }
    for (const id of this.unavailable) if (!wanted.has(id)) this.unavailable.delete(id);
    for (const [id, path] of wanted) {
      if (!this.watchers.has(id)) this.start(id, path);
    }
  }

  state(rootId: string): WatchState {
    if (this.watchers.has(rootId)) return 'active';
    return this.unavailable.has(rootId) ? 'unavailable' : 'off';
  }

  stop(): void {
    for (const id of [...this.watchers.keys()]) this.close(id);
    for (const c of this.changes.values()) clearTimeout(c.timer);
    this.changes.clear();
  }

  private start(rootId: string, path: string): void {
    try {
      const watcher = watch(path, { recursive: true, persistent: false }, (_event, filename) =>
        this.onEvent(rootId, filename),
      );
      watcher.on('error', () => {
        // e.g. the NAS went away: drop the watch, let a scan find out what happened
        this.close(rootId);
        this.unavailable.add(rootId);
        this.queue(rootId, null);
      });
      this.watchers.set(rootId, { watcher, path });
      this.unavailable.delete(rootId);
    } catch {
      this.unavailable.add(rootId);
    }
  }

  private close(rootId: string): void {
    const entry = this.watchers.get(rootId);
    this.watchers.delete(rootId);
    try {
      entry?.watcher.close();
    } catch {
      // already closed
    }
  }

  private onEvent(rootId: string, filename: string | Buffer | null): void {
    if (filename === null) {
      this.queue(rootId, null); // the platform did not say what changed
      return;
    }
    const rel = filename
      .toString()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (!rel) {
      this.queue(rootId, null);
      return;
    }
    if (isIgnoredLibraryPath(rel)) return;
    const ext = extname(rel).slice(1).toLowerCase();
    const slash = rel.lastIndexOf('/');
    const parent = slash < 0 ? '' : rel.slice(0, slash);
    if (AUDIO_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) {
      this.queue(rootId, parent);
    } else if (/^[a-z0-9]{1,5}$/.test(ext) && !/^\d+$/.test(ext)) {
      // .txt/.cue/.log/.nfo… — not music, ignore
    } else {
      this.queue(rootId, rel); // most likely a folder (created, renamed or removed)
    }
  }

  private queue(rootId: string, dir: string | null): void {
    const now = Date.now();
    const c = this.changes.get(rootId) ?? {
      dirs: new Set<string>(),
      full: false,
      first: now,
      timer: setTimeout(() => undefined, 0),
    };
    clearTimeout(c.timer);
    if (dir === null || dir === '') c.full = true;
    else c.dirs.add(dir);
    if (c.dirs.size > this.maxSubtrees) c.full = true;
    const wait = Math.max(0, Math.min(this.quietMs, c.first + this.maxWaitMs - now));
    c.timer = setTimeout(() => this.fire(rootId), wait);
    c.timer.unref?.();
    this.changes.set(rootId, c);
  }

  private fire(rootId: string): void {
    const c = this.changes.get(rootId);
    this.changes.delete(rootId);
    if (!c) return;
    this.onChange(rootId, c.full ? null : [...c.dirs]);
  }
}
