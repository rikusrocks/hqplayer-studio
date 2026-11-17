import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createRedactor, type Redactor, type RedactorOptions } from './redact';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Studio's local log (Phase 5). One rotating text file shared by Core and the Electron main
 * process, plus crash reports, in the app data folder — never uploaded anywhere. Every line goes
 * through the privacy filter (`createRedactor`). Writes are synchronous appends: the volume is
 * small (state changes, commands, scans, errors — never per-status traffic) and a line written
 * just before a crash must not be lost in a buffer.
 */
export interface StudioLog {
  /** Folder of the log files; null when logging to nowhere (tests). */
  readonly dir: string | null;
  info(area: string, message: string, data?: LogData): void;
  warn(area: string, message: string, data?: LogData): void;
  error(area: string, message: string, data?: LogData): void;
  /** The privacy filter used for this log (for other local reports). */
  redact(text: string): string;
  /** Write a crash report (also logged as an error). Returns its file name. */
  crash(kind: string, details: CrashDetails): string | null;
  summary(): LogSummary;
}

export type LogData = Record<string, string | number | boolean | null | undefined>;

export interface CrashDetails {
  error?: unknown;
  /** Extra facts (reason, exit code, …); values are redacted like everything else. */
  info?: LogData;
}

export interface LogSummary {
  /** Files in the log folder (names only). */
  files: Array<{ name: string; sizeBytes: number }>;
  since: string;
  counts: Record<LogLevel, number>;
  /** Latest warnings and errors of this session (already redacted). */
  problems: string[];
  /** Latest lines of any level (already redacted). */
  tail: string[];
  crashReports: Array<{ name: string; at: string; kind: string; summary: string }>;
  /** Studio did not shut down normally last time (crash, killed, power loss). */
  previousSessionUnclean: { startedAt: string; lastAliveAt: string; appVersion: string } | null;
}

export interface FileLogOptions extends RedactorOptions {
  dir: string;
  appVersion: string;
  /** Rotate when the current file would exceed this size. Default 2 MB. */
  maxBytes?: number;
  /** studio.log + this many older files. Default 4. */
  keepFiles?: number;
  /** Crash reports kept. Default 20. */
  keepCrashReports?: number;
  /** Also print to stdout/stderr (development). */
  echo?: boolean;
  now?: () => number;
}

const LOG_FILE = 'studio.log';
const SESSION_FILE = 'session.json';
const CRASH_RE = /^crash-(\d{8}T\d{9}Z)-([a-z-]{1,40})\.txt$/;

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '');
}

function unstamp(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`;
}

function formatData(data: LogData | undefined): string {
  if (!data) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause ? `\nCaused by: ${describeError(err.cause)}` : '';
    return `${err.stack ?? `${err.name}: ${err.message}`}${cause}`;
  }
  try {
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class FileLog implements StudioLog {
  readonly dir: string;
  readonly redact: Redactor;
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keepFiles: number;
  private readonly keepCrash: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private size = 0;
  private readonly counts: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
  private readonly problems: string[] = [];
  private readonly tail: string[] = [];
  private last: { key: string; at: number; repeats: number } | null = null;
  private disabled = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly previous: LogSummary['previousSessionUnclean'];

  constructor(private readonly opts: FileLogOptions) {
    this.dir = opts.dir;
    this.file = join(opts.dir, LOG_FILE);
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    this.keepFiles = opts.keepFiles ?? 4;
    this.keepCrash = opts.keepCrashReports ?? 20;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.redact = createRedactor(opts);
    try {
      mkdirSync(opts.dir, { recursive: true });
      this.size = existsSync(this.file) ? statSync(this.file).size : 0;
    } catch {
      this.disabled = true; // a read-only profile must not stop Studio from starting
    }
    // Reading only: a second copy of the app (which quits at once) must not touch the marker.
    this.previous = this.readPreviousSession();
  }

  info(area: string, message: string, data?: LogData): void {
    this.write('info', area, message, data);
  }

  warn(area: string, message: string, data?: LogData): void {
    this.write('warn', area, message, data);
  }

  error(area: string, message: string, data?: LogData): void {
    this.write('error', area, message, data);
  }

  /**
   * Mark this session as running (heartbeat every minute, so an unclean end can be dated) and
   * report an unclean end of the previous one.
   */
  startSession(): void {
    this.writeSession(false);
    if (this.previous) {
      this.warn(
        'app',
        'the previous session did not end normally (crash, forced quit or power loss)',
        {
          startedAt: this.previous.startedAt,
          lastAliveAt: this.previous.lastAliveAt,
          version: this.previous.appVersion,
        },
      );
      this.crash('unclean-exit', {
        info: {
          startedAt: this.previous.startedAt,
          lastAliveAt: this.previous.lastAliveAt,
          version: this.previous.appVersion,
        },
      });
    }
    this.heartbeat = setInterval(() => this.writeSession(false), 60_000);
    this.heartbeat.unref?.();
  }

  /** Normal shutdown: the next start will not report a crash. */
  endSession(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.flushRepeats();
    this.writeSession(true);
  }

  crash(kind: string, details: CrashDetails): string | null {
    const at = this.now();
    const safeKind = kind.replace(/[^a-z-]/g, '').slice(0, 40) || 'crash';
    const name = `crash-${stamp(at)}-${safeKind}.txt`;
    const error = details.error === undefined ? '' : this.redact(describeError(details.error));
    const firstLine = error.split('\n')[0] ?? '';
    this.write('error', 'crash', `${safeKind}${firstLine ? `: ${firstLine}` : ''}`, details.info);
    if (this.disabled) return null;
    const lines = [
      `HQPlayer Studio crash report (${safeKind})`,
      `time: ${new Date(at).toISOString()}`,
      `version: ${this.opts.appVersion}`,
      `platform: ${process.platform} ${process.arch}, node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''}`,
      ...Object.entries(details.info ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${this.redact(String(v))}`),
      '',
      error ? `error:\n${error}` : 'error: (none)',
      '',
      'last log lines:',
      ...this.tail.slice(-40),
      '',
      'This file stays on this computer. Paths, file names, track names, the computer name and the user name are removed.',
    ];
    try {
      writeFileSync(join(this.dir, name), `${lines.join('\n')}\n`);
      this.pruneCrashReports();
      return name;
    } catch {
      return null;
    }
  }

  summary(): LogSummary {
    let files: LogSummary['files'];
    try {
      files = readdirSync(this.dir)
        .filter((n) => n.endsWith('.log') || CRASH_RE.test(n))
        .map((name) => ({ name, sizeBytes: statSync(join(this.dir, name)).size }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      files = [];
    }
    return {
      files,
      since: new Date(this.startedAt).toISOString(),
      counts: { ...this.counts },
      problems: [...this.problems],
      tail: this.tail.slice(-25),
      crashReports: this.crashReports().slice(0, 10),
      previousSessionUnclean: this.previous,
    };
  }

  /** Newest first. */
  crashReports(): LogSummary['crashReports'] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => CRASH_RE.test(n));
    } catch {
      return [];
    }
    return names
      .sort()
      .reverse()
      .map((name) => {
        const m = CRASH_RE.exec(name) as RegExpExecArray;
        let summary = '';
        try {
          const text = readFileSync(join(this.dir, name), 'utf8');
          summary = (/^error:\n(.*)$/m.exec(text)?.[1] ?? '').slice(0, 300);
        } catch {
          // ignore
        }
        return { name, at: unstamp(m[1] as string), kind: m[2] as string, summary };
      });
  }

  private write(level: LogLevel, area: string, message: string, data?: LogData): void {
    const at = this.now();
    const key = `${level}|${area}|${message}`;
    // the same line again within a minute is counted, not repeated
    if (this.last && this.last.key === key && at - this.last.at < 60_000) {
      this.last.repeats += 1;
      return;
    }
    this.flushRepeats();
    this.last = { key, at, repeats: 0 };
    this.emit(level, area, `${message}${formatData(data)}`, at);
  }

  private flushRepeats(): void {
    if (!this.last || this.last.repeats === 0) return;
    const [level, area] = this.last.key.split('|') as [LogLevel, string];
    const n = this.last.repeats;
    this.last.repeats = 0;
    this.emit(
      level,
      area,
      `(previous line repeated ${n} more time${n === 1 ? '' : 's'})`,
      this.now(),
      false,
    );
  }

  private emit(level: LogLevel, area: string, text: string, at: number, count = true): void {
    const line =
      `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} [${area}] ${this.redact(text)}`.replace(
        /[\r\n]+/g,
        ' ⏎ ',
      );
    if (count) this.counts[level] += 1;
    this.tail.push(line);
    if (this.tail.length > 200) this.tail.splice(0, this.tail.length - 200);
    if (level !== 'info') {
      this.problems.push(line);
      if (this.problems.length > 40) this.problems.splice(0, this.problems.length - 40);
    }
    if (this.opts.echo) {
      (level === 'info' ? console.log : console.error)(`[studio] ${line}`);
    }
    if (this.disabled) return;
    const bytes = Buffer.byteLength(line) + 1;
    try {
      if (this.size + bytes > this.maxBytes && this.size > 0) this.rotate();
      appendFileSync(this.file, `${line}\n`);
      this.size += bytes;
    } catch {
      // disk full / file locked: keep running; the in-memory summary still works
    }
  }

  private rotate(): void {
    const name = (i: number) => join(this.dir, i === 0 ? LOG_FILE : `studio.${i}.log`);
    rmSync(name(this.keepFiles), { force: true });
    for (let i = this.keepFiles - 1; i >= 0; i--) {
      if (existsSync(name(i))) renameSync(name(i), name(i + 1));
    }
    this.size = 0;
  }

  private pruneCrashReports(): void {
    const reports = this.crashReports();
    for (const r of reports.slice(this.keepCrash)) rmSync(join(this.dir, r.name), { force: true });
  }

  private readPreviousSession(): LogSummary['previousSessionUnclean'] {
    try {
      const s = JSON.parse(readFileSync(join(this.dir, SESSION_FILE), 'utf8')) as {
        clean?: boolean;
        startedAt?: number;
        aliveAt?: number;
        appVersion?: string;
      };
      if (s.clean !== false || typeof s.startedAt !== 'number') return null;
      return {
        startedAt: new Date(s.startedAt).toISOString(),
        lastAliveAt: new Date(s.aliveAt ?? s.startedAt).toISOString(),
        appVersion: String(s.appVersion ?? 'unknown').slice(0, 40),
      };
    } catch {
      return null;
    }
  }

  private writeSession(clean: boolean): void {
    if (this.disabled) return;
    try {
      writeFileSync(
        join(this.dir, SESSION_FILE),
        JSON.stringify({
          startedAt: this.startedAt,
          aliveAt: this.now(),
          appVersion: this.opts.appVersion,
          pid: process.pid,
          clean,
        }),
      );
    } catch {
      // ignore
    }
  }
}

/** Logging to nowhere (tests, tools). Keeps the in-memory summary empty. */
export function nullLog(): StudioLog {
  const redact = createRedactor({ appRoots: [] });
  return {
    dir: null,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    redact,
    crash: () => null,
    summary: () => ({
      files: [],
      since: new Date().toISOString(),
      counts: { info: 0, warn: 0, error: 0 },
      problems: [],
      tail: [],
      crashReports: [],
      previousSessionUnclean: null,
    }),
  };
}
