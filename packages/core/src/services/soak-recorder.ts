import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type {
  EngineStatus,
  SoakIncident,
  SoakIncidentKind,
  SoakStatus,
  SoakVerdict,
  StudioEvent,
} from '@hqps/contracts';
import type { EventHub } from '../event-hub';
import type { StudioLog } from '../logging/studio-log';
import {
  READ_ONLY_ENGINE_COMMANDS,
  type EngineCommandEvent,
  type EngineService,
} from './engine-service';

/** What the recorder needs from the engine service (tests pass a stand-in). */
export type SoakEngine = Pick<
  EngineService,
  'getCapabilities' | 'getStatus' | 'onStatus' | 'onCommand'
> & { adapter: { kind: string } };

/**
 * Soak test (Phase 5 exit criterion: "continuous listening and incremental scans cause no
 * playback fault attributable to Studio").
 *
 * A passive recorder: while it runs, it watches HQPlayer's status, the commands Studio sends,
 * library scans (manual / folder watch / schedule) and Studio's own main-thread delays, and writes
 * every irregularity — with what Studio was doing at that moment — into a local JSON report the
 * user can send back. It never sends anything to HQPlayer and never changes a setting.
 *
 * Privacy: the report holds no titles, artists, albums, file names, paths, computer or user names
 * — only track numbers, durations, transport states, output format labels and timings.
 */
export interface SoakRecorderOptions {
  /** Folder for reports; null = keep in memory only (tests). */
  dir: string | null;
  appVersion: string;
  log?: StudioLog;
  now?: () => number;
  /** Start the 1 s tick and the main-thread delay monitor (tests drive `tick()` themselves). */
  timers?: boolean;
  /** A status gap while playing longer than this is an incident. HQPlayer pushes ~1/s. */
  gapMs?: number;
  /** Position not moving for this long while playing (outside track starts) is an incident. */
  stallMs?: number;
  /** A transport / track change this soon after a Studio command is attributed to Studio. */
  attributionMs?: number;
  /** Main-thread delay above this is a "studio_stall". */
  lagThresholdMs?: number;
  /** How close to a track's end a stop / track change counts as the natural end. */
  endToleranceMs?: number;
  sampleEveryMs?: number;
  writeEveryMs?: number;
  /** Reports kept in the folder. */
  keepReports?: number;
}

interface Sample {
  t: number;
  transport: string;
  connected: boolean;
  rssMB: number;
  heapMB: number;
  /** Studio process CPU, % of one core, over the last interval. */
  cpuPct: number;
  /** Largest main-thread delay in the interval. */
  maxLagMs: number;
  statusPerMin: number;
  scanning: boolean;
}

interface ScanRun {
  trigger: string;
  startedAt: number;
}

const MAX_INCIDENTS = 1000;
const MAX_SAMPLES = 2000;

function emptyTotals() {
  return {
    connectedMs: 0,
    playingMs: 0,
    scanMs: 0,
    playingWhileScanningMs: 0,
    statusUpdates: 0,
    maxStatusIntervalMs: 0,
    trackChanges: { natural: 0, studio: 0, external: 0 },
    transportChanges: { natural: 0, studio: 0, external: 0 },
    studioCommands: { total: 0, failed: 0, byLabel: {} as Record<string, number> },
    scans: { manual: 0, watch: 0, schedule: 0 } as Record<string, number>,
    /** ms played per output format label (e.g. "DSD512"). */
    outputFormats: {} as Record<string, number>,
  };
}

export class SoakRecorder {
  private readonly now: () => number;
  private readonly gapMs: number;
  private readonly stallMs: number;
  private readonly attributionMs: number;
  private readonly lagThresholdMs: number;
  private readonly endToleranceMs: number;
  private readonly sampleEveryMs: number;
  private readonly writeEveryMs: number;

  private running = false;
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private stopAt: number | null = null;
  private stopReason: SoakStatus['stopReason'] = null;
  private reportFile: string | null = null;
  private engineInfo: { product: string | null; version: string | null; adapter: string } = {
    product: null,
    version: null,
    adapter: 'unknown',
  };

  private totals = emptyTotals();
  private incidents: SoakIncident[] = [];
  private samples: Sample[] = [];
  private droppedIncidents = 0;

  // live state
  private status: EngineStatus | null = null;
  private lastStatusAt = 0;
  private openGap: { from: number; context: SoakIncident['context']; studio: boolean } | null =
    null;
  private positionMovedAt = 0;
  private settleUntil = 0;
  private stallOpen: { from: number; context: SoakIncident['context']; studio: boolean } | null =
    null;
  private readonly inFlight = new Map<number, string>();
  private lastWrite: { label: string; at: number } | null = null;
  private lastSeekAt = 0;
  private readonly scans = new Map<string, ScanRun>();
  private lastScanEndedAt = 0;
  private lastStallAt = 0;
  private disconnectedAt: number | null = null;

  // timers
  private lastTickAt = 0;
  private lastSampleAt = 0;
  private lastWriteAt = 0;
  private statusSinceSample = 0;
  private lagSinceSampleMs = 0;
  private cpu = process.cpuUsage();
  private cpuAt = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly engine: SoakEngine,
    private readonly hub: EventHub,
    private readonly opts: SoakRecorderOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.gapMs = opts.gapMs ?? 5000;
    this.stallMs = opts.stallMs ?? 8000;
    this.attributionMs = opts.attributionMs ?? 15_000;
    this.lagThresholdMs = opts.lagThresholdMs ?? 300;
    this.endToleranceMs = opts.endToleranceMs ?? 10_000;
    this.sampleEveryMs = opts.sampleEveryMs ?? 60_000;
    this.writeEveryMs = opts.writeEveryMs ?? 60_000;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(durationHours: number | null): Promise<SoakStatus> {
    if (this.running) return this.snapshot();
    const now = this.now();
    this.running = true;
    this.startedAt = now;
    this.endedAt = null;
    this.stopReason = null;
    this.stopAt = durationHours ? now + durationHours * 3600_000 : null;
    this.totals = emptyTotals();
    this.incidents = [];
    this.samples = [];
    this.droppedIncidents = 0;
    this.openGap = null;
    this.stallOpen = null;
    this.inFlight.clear();
    this.scans.clear();
    this.lastWrite = null;
    this.lastTickAt = now;
    this.lastSampleAt = now;
    this.lastWriteAt = now;
    this.cpu = process.cpuUsage();
    this.cpuAt = now;
    this.statusSinceSample = 0;
    this.lagSinceSampleMs = 0;
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    this.reportFile = this.opts.dir ? `soak-${stamp}.json` : null;
    try {
      const caps = await this.engine.getCapabilities();
      this.engineInfo = {
        product: caps.engine?.product ?? null,
        version: caps.engine?.version ?? null,
        adapter: this.engine.adapter.kind,
      };
    } catch {
      this.engineInfo = { product: null, version: null, adapter: this.engine.adapter.kind };
    }
    // starting point
    this.status = this.engine.getStatus();
    this.lastStatusAt = now;
    this.positionMovedAt = now;
    this.settleUntil = now + this.settleMs(this.status);
    this.disconnectedAt = this.status.connection === 'connected' ? null : now;

    this.unsubscribers = [
      this.engine.onStatus((s) => this.onStatus(s)),
      this.engine.onCommand((e) => this.onCommand(e)),
      this.hub.subscribe((e) => this.onEvent(e)),
    ];
    if (this.opts.timers !== false) {
      try {
        this.histogram = monitorEventLoopDelay({ resolution: 20 });
        this.histogram.enable();
      } catch {
        this.histogram = null;
      }
      this.ticker = setInterval(() => this.tick(), 1000);
      this.ticker.unref?.();
    }
    this.opts.log?.info('soak', 'soak test started', {
      autoStopHours: durationHours ?? undefined,
      adapter: this.engineInfo.adapter,
    });
    this.writeReport();
    return this.snapshot();
  }

  stop(reason: NonNullable<SoakStatus['stopReason']> = 'user'): SoakStatus {
    if (!this.running) return this.snapshot();
    const now = this.now();
    this.accumulate(now);
    this.closeGap(now);
    this.closeStall(now);
    this.running = false;
    this.endedAt = now;
    this.stopReason = reason;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.histogram?.disable();
    this.histogram = null;
    this.sample(now);
    this.writeReport();
    const s = this.snapshot();
    this.opts.log?.info('soak', 'soak test stopped', {
      reason,
      hours: Math.round(((now - (this.startedAt ?? now)) / 3600_000) * 10) / 10,
      warnings: s.warnings,
      withStudioActivity: s.warningsWithStudioActivity,
      verdict: s.verdict ?? undefined,
    });
    return s;
  }

  snapshot(): SoakStatus {
    const now = this.endedAt ?? this.now();
    const counts: Record<string, number> = {};
    let warnings = 0;
    let withStudio = 0;
    for (const i of this.incidents) {
      counts[i.kind] = (counts[i.kind] ?? 0) + 1;
      if (i.severity !== 'info') {
        warnings += 1;
        if (i.studioActivity) withStudio += 1;
      }
    }
    return {
      running: this.running,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      stopAt: this.stopAt,
      stopReason: this.stopReason,
      reportFile: this.reportFile,
      elapsedMs: this.startedAt ? now - this.startedAt : 0,
      playingMs: this.totals.playingMs,
      scanMs: this.totals.scanMs,
      playingWhileScanningMs: this.totals.playingWhileScanningMs,
      statusUpdates: this.totals.statusUpdates,
      maxStatusIntervalMs: this.totals.maxStatusIntervalMs,
      incidentCounts: counts,
      warnings,
      warningsWithStudioActivity: withStudio,
      verdict: this.startedAt ? this.verdict(warnings, withStudio) : null,
      recent: this.incidents.slice(-20).reverse(),
    };
  }

  /** The full report (what is written to the file). */
  report(): Record<string, unknown> {
    const s = this.snapshot();
    return {
      kind: 'hqplayer-studio-soak-report',
      formatVersion: 1,
      app: {
        version: this.opts.appVersion,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        electron: process.versions.electron ?? null,
      },
      engine: this.engineInfo,
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
      inProgress: s.running,
      stopReason: s.stopReason,
      durationMs: s.elapsedMs,
      settings: {
        statusGapMs: this.gapMs,
        positionStallMs: this.stallMs,
        attributionWindowMs: this.attributionMs,
        studioStallMs: this.lagThresholdMs,
        autoStopAt: s.stopAt ? new Date(s.stopAt).toISOString() : null,
      },
      verdict: s.verdict,
      summary: {
        warnings: s.warnings,
        warningsWithStudioActivity: s.warningsWithStudioActivity,
        incidentCounts: s.incidentCounts,
        droppedIncidents: this.droppedIncidents,
      },
      totals: this.totals,
      incidents: this.incidents,
      samples: this.samples,
      privacy:
        'No file paths, file names, track titles, artists, albums, computer or user names are recorded — only track numbers, durations, states, output formats and timings.',
    };
  }

  /** Called every second (by the timer, or by tests). */
  tick(): void {
    if (!this.running) return;
    const now = this.now();
    this.accumulate(now);
    const s = this.status;
    const playing = s?.connection === 'connected' && s.transport === 'playing';
    // a gap opens when HQPlayer has been silent too long while playing
    if (playing && !this.openGap && now - this.lastStatusAt >= this.gapMs) {
      const context = this.context(this.lastStatusAt);
      this.openGap = { from: this.lastStatusAt, context, studio: this.studioActive(context) };
    }
    // position stall: statuses arrive but the position does not move
    if (
      playing &&
      !this.stallOpen &&
      now >= this.settleUntil &&
      now - this.positionMovedAt >= this.stallMs &&
      now - this.lastStatusAt < this.gapMs
    ) {
      const context = this.context(this.positionMovedAt);
      this.stallOpen = { from: this.positionMovedAt, context, studio: this.studioActive(context) };
    }
    if (this.histogram) {
      const maxMs = this.histogram.max / 1e6;
      this.histogram.reset();
      if (Number.isFinite(maxMs)) this.noteLag(maxMs, now);
    }
    if (now - this.lastSampleAt >= this.sampleEveryMs) this.sample(now);
    if (now - this.lastWriteAt >= this.writeEveryMs) this.writeReport();
    if (this.stopAt && now >= this.stopAt) this.stop('time-limit');
  }

  /** Main-thread delay measured by the caller (tests) or the histogram. */
  noteLag(maxMs: number, now = this.now()): void {
    if (!this.running) return;
    this.lagSinceSampleMs = Math.max(this.lagSinceSampleMs, maxMs);
    if (maxMs < this.lagThresholdMs) return;
    this.lastStallAt = now;
    const context = this.context(now);
    this.add('studio_stall', 'warning', `Studio main thread blocked for ${Math.round(maxMs)} ms`, {
      at: now,
      durationMs: Math.round(maxMs),
      context: { ...context, studioStall: true },
      studio: true,
    });
  }

  // ---------------------------------------------------------------- observers

  private onStatus(next: EngineStatus): void {
    if (!this.running) return;
    const now = this.now();
    this.accumulate(now);
    const prev = this.status;
    const interval = now - this.lastStatusAt;
    const wasPlaying = prev?.connection === 'connected' && prev.transport === 'playing';
    if (wasPlaying && interval > this.totals.maxStatusIntervalMs) {
      this.totals.maxStatusIntervalMs = interval;
    }
    this.totals.statusUpdates += 1;
    this.statusSinceSample += 1;
    this.closeGap(now);
    this.lastStatusAt = now;
    this.status = next;
    if (!prev) return;

    // connection
    if (prev.connection === 'connected' && next.connection !== 'connected') {
      this.disconnectedAt = now;
      const context = this.context(now, prev);
      this.add('disconnect', 'warning', `HQPlayer connection lost (${prev.transport})`, {
        at: now,
        context,
        studio: this.studioActive(context),
      });
      this.closeStall(now);
      return;
    }
    if (prev.connection !== 'connected' && next.connection === 'connected') {
      const down = this.disconnectedAt !== null ? now - this.disconnectedAt : null;
      this.disconnectedAt = null;
      this.add('reconnect', 'info', 'HQPlayer connection restored', {
        at: now,
        durationMs: down,
        context: this.context(now, next),
        studio: false,
      });
      this.settleUntil = now + this.settleMs(next);
      this.positionMovedAt = now;
      return;
    }
    if (next.connection !== 'connected') return;

    const sameTrack = prev.trackIndex === next.trackIndex;
    const nearEnd = this.nearEnd(prev);
    const command = this.recentCommand(now);

    // track changes
    if (!sameTrack && prev.trackIndex !== null && next.trackIndex !== null) {
      if (command) this.totals.trackChanges.studio += 1;
      else if (nearEnd || prev.transport !== 'playing') this.totals.trackChanges.natural += 1;
      else {
        this.totals.trackChanges.external += 1;
        this.add(
          'track_external',
          'info',
          `Track changed from #${prev.trackIndex} to #${next.trackIndex} mid-track without a Studio command`,
          { at: now, context: this.context(now, prev), studio: false },
        );
      }
      this.settleUntil = now + this.settleMs(next);
      this.positionMovedAt = now;
      this.closeStall(now);
    }

    // transport changes
    if (prev.transport !== next.transport && next.transport !== 'stopping') {
      const from = prev.transport === 'stopping' ? 'playing' : prev.transport;
      if (from !== next.transport) {
        if (command) this.totals.transportChanges.studio += 1;
        else if (from === 'playing' && next.transport === 'stopped' && (nearEnd || !sameTrack)) {
          this.totals.transportChanges.natural += 1;
        } else if (from === 'unknown' || next.transport === 'unknown') {
          // nothing to judge
        } else {
          this.totals.transportChanges.external += 1;
          const stoppedPlayback = from === 'playing';
          const context = this.context(now, prev);
          this.add(
            'transport_external',
            stoppedPlayback ? 'warning' : 'info',
            `${from} → ${next.transport} without a Studio command${stoppedPlayback ? ', not at the end of a track' : ''}`,
            { at: now, context, studio: this.studioActive(context) },
          );
        }
      }
      if (next.transport === 'playing') {
        this.settleUntil = now + this.settleMs(next);
        this.positionMovedAt = now;
      } else {
        this.closeStall(now);
      }
    }

    // position
    if (sameTrack && next.transport === 'playing' && prev.transport === 'playing') {
      const delta = next.positionMs - prev.positionMs;
      if (delta !== 0) {
        if (delta > 0) this.closeStall(now);
        this.positionMovedAt = now;
      }
      const seekedByStudio = now - this.lastSeekAt < this.attributionMs;
      const expected = interval;
      const jumped = delta < -3000 || delta > expected + 5000;
      if (jumped && !seekedByStudio && now >= this.settleUntil) {
        this.add(
          'position_jump',
          'info',
          `Position jumped by ${Math.round(delta / 1000)} s without a Studio seek`,
          { at: now, context: this.context(now, prev), studio: false },
        );
        this.settleUntil = now + this.settleMs(next);
      }
    }
  }

  private onCommand(e: EngineCommandEvent): void {
    if (!this.running) return;
    if (e.phase === 'start') {
      if (!READ_ONLY_ENGINE_COMMANDS.has(e.label)) this.inFlight.set(e.id, e.label);
      return;
    }
    this.inFlight.delete(e.id);
    const write = !READ_ONLY_ENGINE_COMMANDS.has(e.label);
    if (write) {
      this.lastWrite = { label: e.label, at: e.at };
      if (e.label === 'seek') this.lastSeekAt = e.at;
      this.totals.studioCommands.total += 1;
      this.totals.studioCommands.byLabel[e.label] =
        (this.totals.studioCommands.byLabel[e.label] ?? 0) + 1;
      this.settleUntil = Math.max(this.settleUntil, e.at + this.settleMs(this.status));
    }
    if (!e.ok) {
      if (write) this.totals.studioCommands.failed += 1;
      const timeout = e.errorName === 'EngineTimeoutError';
      const context = this.context(e.at);
      this.add(
        'command_failed',
        timeout ? 'error' : 'warning',
        `Studio command "${e.label}" failed after ${e.durationMs ?? 0} ms (${e.errorName ?? 'Error'})`,
        {
          at: e.at,
          durationMs: e.durationMs ?? null,
          context: { ...context, studioCommand: e.label, studioCommandAgoMs: 0 },
          studio: true,
        },
      );
    }
  }

  private onEvent(event: StudioEvent): void {
    if (!this.running) return;
    const now = this.now();
    if (event.type === 'library.scan') {
      const { job } = event;
      if (job.state === 'running' && !this.scans.has(job.id)) {
        this.accumulate(now);
        this.scans.set(job.id, { trigger: job.trigger, startedAt: now });
        this.totals.scans[job.trigger] = (this.totals.scans[job.trigger] ?? 0) + 1;
      } else if (
        (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') &&
        this.scans.has(job.id)
      ) {
        this.accumulate(now);
        this.scans.delete(job.id);
        this.lastScanEndedAt = now;
      }
    } else if (event.type === 'queue.changed') {
      const state = event.queue.sync.state;
      if (state === 'out_of_sync' && this.lastSync !== 'out_of_sync') {
        const context = this.context(now);
        this.add(
          'queue_out_of_sync',
          'info',
          `Studio queue no longer matches HQPlayer (${event.queue.sync.code ?? 'unknown'})`,
          { at: now, context, studio: false },
        );
      }
      this.lastSync = state;
    }
  }

  private lastSync: string | null = null;

  // ---------------------------------------------------------------- helpers

  /** Time after a track start / play / seek during which position and jumps are not judged. */
  private settleMs(s: EngineStatus | null): number {
    return 10_000 + (s?.outputDelayMs ?? 0);
  }

  private nearEnd(s: EngineStatus): boolean {
    if (s.durationMs === null || s.durationMs <= 0) return true; // unknown length: do not accuse
    return s.positionMs >= s.durationMs - this.endToleranceMs;
  }

  /** A Studio write command in flight, or one that ended within the attribution window. */
  private recentCommand(now: number): { label: string; agoMs: number } | null {
    const flying = [...this.inFlight.values()].at(-1);
    if (flying) return { label: flying, agoMs: 0 };
    if (this.lastWrite && now - this.lastWrite.at <= this.attributionMs) {
      return { label: this.lastWrite.label, agoMs: now - this.lastWrite.at };
    }
    return null;
  }

  private context(at: number, s: EngineStatus | null = this.status): SoakIncident['context'] {
    const command = this.recentCommand(at);
    const scans = [...this.scans.values()].map((r) => r.trigger);
    if (scans.length === 0 && this.lastScanEndedAt && at - this.lastScanEndedAt < 10_000) {
      scans.push('just-ended');
    }
    return {
      transport: s
        ? `${s.connection === 'connected' ? '' : `${s.connection}/`}${s.transport}`
        : 'unknown',
      output: s?.output?.label ?? null,
      studioCommand: command?.label ?? null,
      studioCommandAgoMs: command?.agoMs ?? null,
      scans,
      studioStall: this.lastStallAt > 0 && at - this.lastStallAt < 10_000,
    };
  }

  private studioActive(c: SoakIncident['context']): boolean {
    return c.studioCommand !== null || c.scans.length > 0 || c.studioStall;
  }

  private add(
    kind: SoakIncidentKind,
    severity: SoakIncident['severity'],
    detail: string,
    x: {
      at: number;
      durationMs?: number | null;
      context: SoakIncident['context'];
      studio: boolean;
    },
  ): void {
    const incident: SoakIncident = {
      at: x.at,
      kind,
      severity,
      detail,
      durationMs: x.durationMs ?? null,
      context: x.context,
      studioActivity: x.studio,
    };
    this.incidents.push(incident);
    if (this.incidents.length > MAX_INCIDENTS) {
      // keep warnings: drop the oldest informational entry first
      const i = this.incidents.findIndex((x) => x.severity === 'info');
      this.incidents.splice(i >= 0 ? i : 0, 1);
      this.droppedIncidents += 1;
    }
    if (severity !== 'info') {
      this.opts.log?.warn('soak', `${kind}: ${detail}`, {
        studioActivity: x.studio,
        command: x.context.studioCommand ?? undefined,
        scans: x.context.scans.join(',') || undefined,
      });
    }
  }

  private closeGap(now: number): void {
    if (!this.openGap) return;
    const gap = this.openGap;
    this.openGap = null;
    this.add(
      'status_gap',
      'warning',
      `No status from HQPlayer for ${Math.round((now - gap.from) / 100) / 10} s while playing`,
      { at: gap.from, durationMs: now - gap.from, context: gap.context, studio: gap.studio },
    );
  }

  private closeStall(now: number): void {
    if (!this.stallOpen) return;
    const stall = this.stallOpen;
    this.stallOpen = null;
    this.add(
      'position_stall',
      'warning',
      `Position did not advance for ${Math.round((now - stall.from) / 100) / 10} s while playing`,
      {
        at: stall.from,
        durationMs: now - stall.from,
        context: stall.context,
        studio: stall.studio,
      },
    );
  }

  private accumulate(now: number): void {
    const dt = Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    if (dt === 0 || !this.status) return;
    const connected = this.status.connection === 'connected';
    const playing = connected && this.status.transport === 'playing';
    const scanning = this.scans.size > 0;
    if (connected) this.totals.connectedMs += dt;
    if (scanning) this.totals.scanMs += dt;
    if (playing) {
      this.totals.playingMs += dt;
      if (scanning) this.totals.playingWhileScanningMs += dt;
      const label = this.status.output?.label ?? 'unknown';
      this.totals.outputFormats[label] = (this.totals.outputFormats[label] ?? 0) + dt;
    }
  }

  private sample(now: number): void {
    const interval = Math.max(1, now - this.lastSampleAt);
    const cpu = process.cpuUsage(this.cpu);
    const wall = Math.max(1, now - this.cpuAt);
    this.cpu = process.cpuUsage();
    this.cpuAt = now;
    const mem = process.memoryUsage();
    this.samples.push({
      t: now,
      transport: this.status ? `${this.status.connection}/${this.status.transport}` : 'unknown',
      connected: this.status?.connection === 'connected',
      rssMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
      cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 1000) / 10,
      maxLagMs: Math.round(this.lagSinceSampleMs),
      statusPerMin: Math.round((this.statusSinceSample / interval) * 60_000),
      scanning: this.scans.size > 0,
    });
    if (this.samples.length > MAX_SAMPLES) {
      // long runs: keep every other old sample
      this.samples = this.samples.filter((_, i) => i % 2 === 0 || i > this.samples.length - 200);
    }
    this.lastSampleAt = now;
    this.statusSinceSample = 0;
    this.lagSinceSampleMs = 0;
  }

  private verdict(warnings: number, withStudio: number): SoakVerdict {
    if (warnings === 0) return 'clean';
    return withStudio > 0 ? 'issues-with-studio-activity' : 'issues-without-studio-activity';
  }

  private writeReport(): void {
    this.lastWriteAt = this.now();
    const dir = this.opts.dir;
    if (!dir || !this.reportFile) return;
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, this.reportFile);
      const temp = `${file}.partial`;
      writeFileSync(temp, `${JSON.stringify(this.report(), null, 2)}\n`);
      renameSync(temp, file);
      this.prune(dir);
    } catch (err) {
      this.opts.log?.warn('soak', 'could not write the soak report', {
        error: (err as Error).message,
      });
    }
  }

  private prune(dir: string): void {
    const keep = this.opts.keepReports ?? 20;
    const reports = readdirSync(dir)
      .filter((n) => /^soak-\d{8}T\d{6}Z\.json$/.test(n))
      .sort()
      .reverse();
    for (const name of reports.slice(keep)) rmSync(join(dir, name), { force: true });
  }
}
