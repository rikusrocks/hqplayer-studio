import type { LibraryRoot, LibrarySettings, ScanJob } from '@hqps/contracts';
import { newId, scanRoot, type LibraryContext } from '@hqps/library';
import type { EventHub } from '../event-hub';
import { DEMO_REMOVED_SETTING, ONLINE_ALBUM_CHECK_SETTING } from '../settings-keys';
import type { OnlineAlbumChecker } from './online-albums';
import { LibraryWatcher, type LibraryWatcherOptions } from './library-watcher';

export type ScanTrigger = ScanJob['trigger'];

export interface LibraryServiceOptions {
  /** Watch roots for changes and rescan just the changed folders (default on). */
  watch?: boolean;
  watcher?: LibraryWatcherOptions;
  /** Periodic fallback: full incremental rescan when the last full scan is older than this. */
  rescanAfterMs?: number;
  /** …and much sooner when a root cannot be watched (changes would otherwise go unnoticed). */
  rescanUnwatchedAfterMs?: number;
  /** How often the fallback schedule is checked (also retries failed watchers). */
  tickMs?: number;
  /** Awaited before each file of a scan (CoreServer slows scans while HQPlayer plays). */
  pace?: () => Promise<void>;
  /** Called (synchronously) after tracks were removed from the library, e.g. to fix the queue. */
  onTracksRemoved?: (trackIds: ReadonlySet<string>) => void;
  /** Opt-in MusicBrainz check (only used while the user has switched it on). */
  onlineChecker?: OnlineAlbumChecker;
}

interface JobPlan {
  /** null = whole root */
  subtrees: string[] | null;
}

/**
 * Library roots + scan jobs. Scans run one at a time with low metadata concurrency so they don't
 * compete with HQPlayer for disk I/O during DSD512 playback.
 *
 * Automatic updates (handoff §8.1): a file watcher queues rescans of just the folders that
 * changed; a low-frequency fallback scan catches anything the watcher missed. Startup never
 * forces a full scan — only when the last one is older than `rescanAfterMs`.
 */
export class LibraryService {
  private readonly jobs = new Map<string, ScanJob>();
  private readonly plans = new Map<string, JobPlan>();
  private readonly pending: string[] = [];
  private running = false;
  private abort: AbortController | null = null;
  private readonly watcher: LibraryWatcher | null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private readonly rescanAfterMs: number;
  private readonly rescanUnwatchedAfterMs: number;
  private readonly tickMs: number;
  private online: {
    running: boolean;
    lastRunAt: number | null;
    lastRun: { checked: number; merged: number; unmatched: number; failed: number } | null;
    chain: Promise<void>;
  } = { running: false, lastRunAt: null, lastRun: null, chain: Promise.resolve() };

  constructor(
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
    private readonly options: LibraryServiceOptions = {},
  ) {
    this.watcher =
      options.watch === false
        ? null
        : new LibraryWatcher(
            ctx,
            (rootId, subtrees) => this.scan(rootId, { trigger: 'watch', subtrees }),
            options.watcher,
          );
    this.rescanAfterMs = options.rescanAfterMs ?? 12 * 3600_000;
    this.rescanUnwatchedAfterMs = options.rescanUnwatchedAfterMs ?? 3600_000;
    this.tickMs = options.tickMs ?? 5 * 60_000;
  }

  /** Begin watching and the fallback schedule (called when the server starts listening). */
  start(): void {
    this.watcher?.sync();
    if (this.tick) return;
    this.tick = setInterval(() => this.onTick(), this.tickMs);
    this.tick.unref?.();
  }

  listRoots(): LibraryRoot[] {
    return this.ctx.library
      .listRoots()
      .map((r) => ({ ...r, watching: r.kind === 'fixture' ? 'off' : this.watchState(r.id) }));
  }

  watchState(rootId: string): NonNullable<LibraryRoot['watching']> {
    return this.watcher?.state(rootId) ?? 'off';
  }

  addRoot(path: string): LibraryRoot {
    const root = this.ctx.library.addRoot(path);
    this.scan(root.id);
    this.watcher?.sync();
    return { ...root, watching: this.watchState(root.id) };
  }

  scan(
    rootId?: string,
    opts: { trigger?: ScanTrigger; subtrees?: string[] | null } = {},
  ): ScanJob[] {
    const trigger = opts.trigger ?? 'manual';
    const subtrees = opts.subtrees && opts.subtrees.length ? opts.subtrees : null;
    const roots = rootId
      ? [this.ctx.library.getRootRow(rootId)]
      : this.ctx.library.listRoots().filter((r) => r.enabled);
    const created: ScanJob[] = [];
    for (const r of roots) {
      const queued = [...this.jobs.values()].find((j) => j.rootId === r.id && j.state === 'queued');
      if (queued) {
        // merge into the waiting job: whole root wins, otherwise the union of folders
        const plan = this.plans.get(queued.id) as JobPlan;
        plan.subtrees =
          plan.subtrees && subtrees ? [...new Set([...plan.subtrees, ...subtrees])] : null;
        if (trigger === 'manual') queued.trigger = 'manual';
        created.push(queued);
        continue;
      }
      const running = [...this.jobs.values()].find(
        (j) => j.rootId === r.id && j.state === 'running',
      );
      if (
        running &&
        trigger === 'manual' &&
        !subtrees &&
        this.plans.get(running.id)?.subtrees === null
      ) {
        created.push(running); // a full scan of this root is already under way
        continue;
      }
      const job: ScanJob = {
        id: newId('scan'),
        rootId: r.id,
        state: 'queued',
        trigger,
        startedAt: null,
        finishedAt: null,
        filesSeen: 0,
        filesParsed: 0,
        filesUnchanged: 0,
        added: 0,
        updated: 0,
        moved: 0,
        markedUnavailable: 0,
        errors: 0,
        currentFolder: null,
        message: null,
      };
      this.jobs.set(job.id, job);
      this.plans.set(job.id, { subtrees });
      this.pending.push(job.id);
      this.hub.publish({ type: 'library.scan', job });
      created.push(job);
    }
    this.trimJobs();
    void this.pump();
    return created;
  }

  /**
   * Remove a library folder and everything indexed from it (files on disk stay). Waits for a
   * scan of that folder to stop first, so it cannot write tracks back afterwards.
   */
  async removeRoot(rootId: string) {
    const root = this.ctx.library.getRootRow(rootId);
    for (const [i, id] of [...this.pending.entries()].reverse()) {
      const job = this.jobs.get(id);
      if (job?.rootId === rootId) {
        this.pending.splice(i, 1);
        Object.assign(job, {
          state: 'cancelled',
          finishedAt: Date.now(),
          message: 'Folder removed',
        });
        this.hub.publish({ type: 'library.scan', job: { ...job } });
      }
    }
    const isRunning = () =>
      [...this.jobs.values()].some((j) => j.rootId === rootId && j.state === 'running');
    if (isRunning()) this.abort?.abort();
    while (isRunning()) await new Promise((r) => setTimeout(r, 20));
    const removed = this.ctx.library.removeRoot(rootId);
    this.ctx.library.recomputeDuplicates();
    if (root.kind === 'fixture') this.ctx.settings.set(DEMO_REMOVED_SETTING, true);
    this.options.onTracksRemoved?.(new Set(removed.trackIds));
    this.watcher?.sync();
    this.hub.publish({ type: 'library.changed', stats: this.ctx.library.stats() });
    if (removed.playlistItems || removed.playlistsRemoved) {
      this.hub.publish({ type: 'playlists.changed', playlistId: null });
    }
    const { trackIds: _ids, ...summary } = removed;
    return summary;
  }

  /** Settings → Library: duplicate albums (backup copies) and the online album check. */
  librarySettings(): LibrarySettings {
    return {
      onlineAlbumCheck: {
        enabled: this.onlineEnabled(),
        running: this.online.running,
        lastRunAt: this.online.lastRunAt,
        lastRun: this.online.lastRun,
      },
      duplicates: this.ctx.library.listDuplicates(),
    };
  }

  setOnlineAlbumCheck(enabled: boolean): LibrarySettings {
    this.ctx.settings.set(ONLINE_ALBUM_CHECK_SETTING, enabled);
    if (enabled) this.queueOnlineCheck();
    return this.librarySettings();
  }

  private onlineEnabled(): boolean {
    return (
      Boolean(this.options.onlineChecker) &&
      this.ctx.settings.get(ONLINE_ALBUM_CHECK_SETTING, false)
    );
  }

  /** Runs one check at a time, in the background; never blocks scans. */
  private queueOnlineCheck(rootId?: string): void {
    const checker = this.options.onlineChecker;
    if (!checker || !this.onlineEnabled()) return;
    this.online.chain = this.online.chain.then(async () => {
      if (!this.onlineEnabled()) return;
      this.online.running = true;
      try {
        const res = await checker.run(rootId);
        this.online.lastRun = res;
        this.online.lastRunAt = Date.now();
        if (res.merged > 0) {
          this.ctx.library.recomputeDuplicates();
          this.hub.publish({ type: 'library.changed', stats: this.ctx.library.stats() });
        }
      } catch {
        // network trouble: the next scan or toggle tries again
      } finally {
        this.online.running = false;
      }
    });
  }

  /** Resolves when background online checks are done (tests). */
  async onlineIdle(): Promise<void> {
    await this.online.chain;
  }

  getJob(id: string): ScanJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): ScanJob[] {
    return [...this.jobs.values()].slice(-20).reverse();
  }

  async stop(): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.watcher?.stop();
    this.pending.length = 0;
    this.abort?.abort();
  }

  /** Resolves when no scan is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.running || this.pending.length) await new Promise((r) => setTimeout(r, 10));
  }

  /** Fallback schedule: rescan roots whose last full scan is too old; retry failed watchers. */
  private onTick(): void {
    this.watcher?.sync();
    const now = Date.now();
    for (const r of this.ctx.library.listRoots()) {
      if (!r.enabled || r.kind === 'fixture') continue;
      const limit =
        this.watchState(r.id) === 'active' ? this.rescanAfterMs : this.rescanUnwatchedAfterMs;
      if (r.lastScannedAt === null || now - r.lastScannedAt >= limit) {
        this.scan(r.id, { trigger: 'schedule' });
      }
    }
  }

  private trimJobs(): void {
    const finished = [...this.jobs.values()].filter(
      (j) => j.state !== 'queued' && j.state !== 'running',
    );
    for (const j of finished.slice(0, Math.max(0, finished.length - 50))) {
      this.jobs.delete(j.id);
      this.plans.delete(j.id);
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.pending.shift(); id; id = this.pending.shift()) {
        const job = this.jobs.get(id);
        if (!job) continue;
        const plan = this.plans.get(id) ?? { subtrees: null };
        this.abort = new AbortController();
        const update = (patch: Partial<ScanJob>) => {
          Object.assign(job, patch);
          this.hub.publish({ type: 'library.scan', job: { ...job } });
        };
        update({ state: 'running', startedAt: Date.now() });
        try {
          const res = await scanRoot({
            library: this.ctx.library,
            artwork: this.ctx.artwork,
            rootId: job.rootId,
            signal: this.abort.signal,
            onProgress: (p) => update({ ...p }),
            subtrees: plan.subtrees ?? undefined,
            artworkScope: job.trigger === 'manual' ? 'all' : 'changed',
            pace: this.options.pace,
          });
          update({
            ...res,
            state: res.state,
            message: res.message,
            finishedAt: res.finishedAt,
            startedAt: res.startedAt,
          });
        } catch (err) {
          update({ state: 'failed', finishedAt: Date.now(), message: (err as Error).message });
        }
        const quiet =
          job.trigger !== 'manual' &&
          job.added + job.updated + job.moved + job.markedUnavailable === 0;
        if (!quiet) {
          // backup copies: show one of each album (recomputed — availability may have changed)
          this.ctx.library.recomputeDuplicates();
          this.hub.publish({ type: 'library.changed', stats: this.ctx.library.stats() });
          this.queueOnlineCheck(job.rootId);
        }
      }
    } finally {
      this.running = false;
      this.abort = null;
    }
  }
}
