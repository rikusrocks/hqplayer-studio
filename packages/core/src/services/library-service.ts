import type { LibraryRoot, ScanJob } from '@hqps/contracts';
import { newId, scanRoot, type LibraryContext } from '@hqps/library';
import type { EventHub } from '../event-hub';

/**
 * Library roots + scan jobs. Scans run one at a time with low metadata concurrency so they don't
 * compete with HQPlayer for disk I/O during DSD512 playback.
 */
export class LibraryService {
  private readonly jobs = new Map<string, ScanJob>();
  private readonly pending: string[] = [];
  private running = false;
  private abort: AbortController | null = null;

  constructor(
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
  ) {}

  addRoot(path: string): LibraryRoot {
    const root = this.ctx.library.addRoot(path);
    this.scan(root.id);
    return root;
  }

  scan(rootId?: string): ScanJob[] {
    const roots = rootId
      ? [this.ctx.library.getRootRow(rootId)]
      : this.ctx.library.listRoots().filter((r) => r.enabled);
    const created: ScanJob[] = [];
    for (const r of roots) {
      const already = [...this.jobs.values()].find(
        (j) => j.rootId === r.id && (j.state === 'queued' || j.state === 'running'),
      );
      if (already) {
        created.push(already);
        continue;
      }
      const job: ScanJob = {
        id: newId('scan'),
        rootId: r.id,
        state: 'queued',
        startedAt: null,
        finishedAt: null,
        filesSeen: 0,
        filesParsed: 0,
        filesUnchanged: 0,
        added: 0,
        updated: 0,
        markedUnavailable: 0,
        errors: 0,
        currentFolder: null,
        message: null,
      };
      this.jobs.set(job.id, job);
      this.pending.push(job.id);
      this.hub.publish({ type: 'library.scan', job });
      created.push(job);
    }
    void this.pump();
    return created;
  }

  getJob(id: string): ScanJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): ScanJob[] {
    return [...this.jobs.values()].slice(-20).reverse();
  }

  async stop(): Promise<void> {
    this.pending.length = 0;
    this.abort?.abort();
  }

  /** Resolves when no scan is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.running || this.pending.length) await new Promise((r) => setTimeout(r, 10));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.pending.shift(); id; id = this.pending.shift()) {
        const job = this.jobs.get(id);
        if (!job) continue;
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
        this.hub.publish({ type: 'library.changed', stats: this.ctx.library.stats() });
      }
    } finally {
      this.running = false;
      this.abort = null;
    }
  }
}
