import type { EngineStatus } from '@hqps/contracts';
import type { EventHub } from '../event-hub';
import { READ_ONLY_ENGINE_COMMANDS, type EngineService } from '../services/engine-service';
import type { StudioLog } from './studio-log';

/**
 * What Core writes to the local log: state changes and actions, never per-status traffic and
 * never titles, artists or paths (track numbers and format labels only).
 */
export function attachActivityLog(
  engine: EngineService,
  hub: EventHub,
  log: StudioLog,
): () => void {
  let prev: EngineStatus | null = null;
  const offStatus = engine.onStatus((s) => {
    const p = prev;
    prev = s;
    if (!p || p.connection !== s.connection) {
      if (s.connection === 'connected') {
        log.info('engine', 'HQPlayer connected', { adapter: engine.adapter.kind });
      } else if (p?.connection === 'connected' || !p) {
        log.warn('engine', `HQPlayer ${s.connection}`, {
          adapter: engine.adapter.kind,
          error: s.lastError ?? undefined,
        });
      }
    }
    if (s.connection !== 'connected') return;
    if (!p || p.transport !== s.transport) {
      log.info('engine', `transport ${s.transport}`, {
        track: s.trackIndex ?? undefined,
        of: s.trackCount ?? undefined,
        output: s.transport === 'playing' ? (s.output?.label ?? undefined) : undefined,
      });
    } else if (p.trackIndex !== s.trackIndex && s.trackIndex !== null) {
      log.info('engine', `track ${s.trackIndex}`, {
        of: s.trackCount ?? undefined,
        output: s.output?.label ?? undefined,
      });
    }
  });
  const offCommands = engine.onCommand((e) => {
    if (e.phase !== 'end') return;
    if (e.ok) {
      if (!READ_ONLY_ENGINE_COMMANDS.has(e.label)) {
        log.info('command', `${e.label} ok`, { ms: e.durationMs });
      }
    } else {
      log.warn('command', `${e.label} failed`, {
        ms: e.durationMs,
        type: e.errorName,
        error: e.error,
      });
    }
  });
  const scanStates = new Map<string, string>();
  let lastSync: string | null = null;
  const offHub = hub.subscribe((event) => {
    if (event.type === 'library.scan') {
      const { job } = event;
      if (scanStates.get(job.id) === job.state) return;
      scanStates.set(job.id, job.state);
      if (job.state === 'running') {
        log.info('library', 'scan started', { trigger: job.trigger });
      } else if (job.state !== 'queued') {
        scanStates.delete(job.id);
        const data = {
          trigger: job.trigger,
          seen: job.filesSeen,
          parsed: job.filesParsed,
          added: job.added,
          updated: job.updated,
          moved: job.moved,
          unavailable: job.markedUnavailable,
          errors: job.errors,
          ms: job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : undefined,
        };
        if (job.state === 'completed') log.info('library', 'scan completed', data);
        else
          log.warn('library', `scan ${job.state}`, { ...data, message: job.message ?? undefined });
      }
    } else if (event.type === 'notice' && event.level !== 'info') {
      const write = event.level === 'error' ? log.error : log.warn;
      write.call(log, 'notice', `${event.code}: ${event.message}`);
    } else if (event.type === 'queue.changed') {
      const state = event.queue.sync.state;
      if (state === 'out_of_sync' && lastSync !== 'out_of_sync') {
        log.info('queue', 'out of sync with HQPlayer', {
          code: event.queue.sync.code ?? undefined,
        });
      }
      lastSync = state;
    }
  });
  return () => {
    offStatus();
    offCommands();
    offHub();
  };
}
