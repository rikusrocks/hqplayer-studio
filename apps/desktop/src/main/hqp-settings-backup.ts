/**
 * Backups of HQPlayer Desktop's own settings file, and putting one back.
 *
 * HQPlayer keeps everything it is set to — output device and buffer, input, volume options,
 * DSP, convolution / matrix — in one XML file (Windows: `%LOCALAPPDATA%\HQPlayer\settings.xml`,
 * macOS / Linux: `~/.hqplayer/settings.xml`). Users have seen HQPlayer come back with blank
 * default settings after switching back and forth between the library and a live input; the
 * control API cannot set devices, so the only full recovery is the file itself.
 *
 * Backing up only READS that file: whenever its content changes, a copy goes to Studio's own
 * folder (duplicates are skipped). A copy that is much smaller than the best earlier one is
 * marked "looks reset" and Studio offers to put the earlier one back.
 *
 * Restoring is the only time Studio writes HQPlayer's files, and only when the user clicks
 * Restore: HQPlayer is closed first (it writes its settings when it quits), the current file is
 * kept as one more backup, the chosen copy is written (temp file + rename), and HQPlayer is
 * started again.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export type HqpSettingsBackupReason = 'auto' | 'manual' | 'before-restore';

export interface HqpSettingsBackup {
  id: string;
  /** Epoch ms the copy was taken. */
  at: number;
  size: number;
  /** sha256 of the content (hex). */
  hash: string;
  /** Number of XML elements — a rough measure of how much is set. */
  elements: number;
  reason: HqpSettingsBackupReason;
  /** Kept forever (never pruned). */
  pinned: boolean;
  /** Much smaller than the best earlier copy: HQPlayer probably reset its settings. */
  suspect: boolean;
}

export interface HqpSettingsResetWarning {
  at: number;
  /** The copy that looks reset (what HQPlayer has now). */
  currentId: string;
  /** The copy Studio suggests putting back. */
  goodId: string;
}

export interface HqpSettingsBackupState {
  supported: boolean;
  /** Where HQPlayer's settings file is looked for. */
  settingsPath: string | null;
  found: boolean;
  /** Newest first. */
  backups: HqpSettingsBackup[];
  resetWarning: HqpSettingsResetWarning | null;
  lastCheckAt: number | null;
  lastError: string | null;
}

export type RestoreStepId = 'read' | 'close' | 'keep-current' | 'write' | 'start';
export interface RestoreStep {
  id: RestoreStepId;
  ok: boolean;
  detail?: string;
}
export interface RestoreReport {
  ok: boolean;
  backupId: string;
  steps: RestoreStep[];
  /** Why it stopped (machine-readable). */
  error?: 'not_found' | 'damaged' | 'still_running' | 'write_failed' | 'no_settings_path';
}

/** Starting / closing HQPlayer (Windows: the window script and the launcher in main.ts). */
export interface HqpProcessControl {
  isRunning(): Promise<boolean>;
  /** Ask HQPlayer to quit the normal way (like closing its window). */
  close(): Promise<void>;
  start(): Promise<void>;
}

export interface BackupDeps {
  /** Folder for the copies and the index. */
  dir: string;
  /** HQPlayer's settings file (null: not on this platform). */
  settingsPath: () => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for HQPlayer to quit. Default 20 s. */
  closeTimeoutMs?: number;
  /** Keep this many unpinned copies. Default 30. */
  keep?: number;
}

const INDEX = 'index.json';
/** A copy with fewer elements than this share of the best earlier copy looks reset. */
const RESET_RATIO = 0.6;
/** Below this many elements the file is too small to judge. */
const MIN_ELEMENTS_TO_JUDGE = 20;

/** The default location of HQPlayer Desktop's settings file on this platform. */
export function defaultSettingsPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  if (platform === 'win32') {
    const base =
      env.LOCALAPPDATA ??
      (env.USERPROFILE ? win32.join(env.USERPROFILE, 'AppData', 'Local') : null);
    return base ? win32.join(base, 'HQPlayer', 'settings.xml') : null;
  }
  return posix.join(home, '.hqplayer', 'settings.xml');
}

/** Rough element count (opening tags and self-closing tags, no comments / declarations). */
export function countElements(xml: string): number {
  return (xml.match(/<[A-Za-z_][^>]*>/g) ?? []).length;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

export class HqpSettingsBackups {
  private backups: HqpSettingsBackup[] = [];
  private resetWarning: HqpSettingsResetWarning | null = null;
  private lastCheckAt: number | null = null;
  private lastError: string | null = null;
  private found = false;
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: BackupDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One operation at a time (a check never runs in the middle of a restore). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(join(this.deps.dir, INDEX), 'utf8')) as {
        backups?: HqpSettingsBackup[];
        resetWarning?: HqpSettingsResetWarning | null;
      };
      this.backups = Array.isArray(raw.backups) ? raw.backups : [];
      this.resetWarning = raw.resetWarning ?? null;
    } catch {
      this.backups = [];
    }
  }

  private async save(): Promise<void> {
    await fsp.mkdir(this.deps.dir, { recursive: true });
    const tmp = join(this.deps.dir, `${INDEX}.tmp`);
    await fsp.writeFile(
      tmp,
      JSON.stringify({ backups: this.backups, resetWarning: this.resetWarning }, null, 1),
    );
    await fsp.rename(tmp, join(this.deps.dir, INDEX));
  }

  private fileOf(b: HqpSettingsBackup): string {
    return join(this.deps.dir, `${b.id}.xml`);
  }

  state(): Promise<HqpSettingsBackupState> {
    return this.serial(async () => {
      await this.load();
      return this.snapshotState();
    });
  }

  private snapshotState(): HqpSettingsBackupState {
    const path = this.deps.settingsPath();
    return {
      supported: path !== null,
      settingsPath: path,
      found: this.found,
      backups: [...this.backups].sort((a, b) => b.at - a.at),
      resetWarning: this.resetWarning,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
    };
  }

  /** Copy HQPlayer's settings file if it changed since the newest copy. */
  check(reason: HqpSettingsBackupReason = 'auto'): Promise<HqpSettingsBackupState> {
    return this.serial(async () => {
      await this.load();
      await this.takeCopy(reason);
      return this.snapshotState();
    });
  }

  private async takeCopy(reason: HqpSettingsBackupReason): Promise<HqpSettingsBackup | null> {
    this.lastCheckAt = this.now();
    const path = this.deps.settingsPath();
    if (!path) return null;
    let data: Buffer;
    try {
      data = await fsp.readFile(path);
      this.found = true;
      this.lastError = null;
    } catch (err) {
      this.found = false;
      const code = (err as NodeJS.ErrnoException).code;
      this.lastError = code === 'ENOENT' ? null : `${code ?? 'read failed'}`;
      return null;
    }
    const hash = sha256(data);
    const newest = [...this.backups].sort((a, b) => b.at - a.at)[0];
    if (newest && newest.hash === hash && reason === 'auto') return null;
    const existing = this.backups.find((b) => b.hash === hash);
    if (existing && reason === 'auto') {
      // back to content Studio has seen before; a full copy again means no more warning
      if (!existing.suspect && this.resetWarning) {
        this.resetWarning = null;
        await this.save();
      }
      return null;
    }

    const elements = countElements(data.toString('utf8'));
    const best = this.bestGood();
    const suspect =
      best !== null &&
      best.elements >= MIN_ELEMENTS_TO_JUDGE &&
      elements < best.elements * RESET_RATIO;
    const at = this.now();
    const backup: HqpSettingsBackup = {
      id: `${stamp(at)}-${hash.slice(0, 8)}`,
      at,
      size: data.length,
      hash,
      elements,
      reason,
      pinned: false,
      suspect,
    };
    await fsp.mkdir(this.deps.dir, { recursive: true });
    if (!this.backups.some((b) => b.id === backup.id)) {
      await fsp.writeFile(this.fileOf(backup), data);
      this.backups.push(backup);
    }
    if (suspect && best && reason === 'auto') {
      this.resetWarning = { at, currentId: backup.id, goodId: best.id };
    } else if (!suspect && reason === 'auto') {
      // HQPlayer has full settings again (fixed by hand, or restored): nothing to warn about
      this.resetWarning = null;
    }
    await this.prune();
    await this.save();
    return backup;
  }

  /** The copy with the most settings among those that do not look reset (newest on a tie). */
  private bestGood(): HqpSettingsBackup | null {
    let best: HqpSettingsBackup | null = null;
    for (const b of this.backups) {
      if (b.suspect) continue;
      if (!best || b.elements > best.elements || (b.elements === best.elements && b.at > best.at)) {
        best = b;
      }
    }
    return best;
  }

  private async prune(): Promise<void> {
    const keep = this.deps.keep ?? 30;
    const protect = new Set<string>();
    const best = this.bestGood();
    if (best) protect.add(best.id);
    if (this.resetWarning) {
      protect.add(this.resetWarning.goodId);
      protect.add(this.resetWarning.currentId);
    }
    const sorted = [...this.backups].sort((a, b) => b.at - a.at);
    let unpinned = 0;
    const drop: HqpSettingsBackup[] = [];
    for (const b of sorted) {
      if (b.pinned || protect.has(b.id)) continue;
      unpinned += 1;
      if (unpinned > keep) drop.push(b);
    }
    for (const b of drop) {
      await fsp.rm(this.fileOf(b), { force: true });
      this.backups = this.backups.filter((x) => x.id !== b.id);
    }
  }

  setPinned(id: string, pinned: boolean): Promise<HqpSettingsBackupState> {
    return this.serial(async () => {
      await this.load();
      const b = this.backups.find((x) => x.id === id);
      if (b) {
        b.pinned = pinned;
        await this.save();
      }
      return this.snapshotState();
    });
  }

  dismissWarning(): Promise<HqpSettingsBackupState> {
    return this.serial(async () => {
      await this.load();
      this.resetWarning = null;
      await this.save();
      return this.snapshotState();
    });
  }

  /** Put a copy back: close HQPlayer, keep the current file, write the copy, start HQPlayer. */
  restore(id: string, ctl: HqpProcessControl): Promise<RestoreReport> {
    return this.serial(async () => {
      await this.load();
      const steps: RestoreStep[] = [];
      const fail = (error: RestoreReport['error']): RestoreReport => ({
        ok: false,
        backupId: id,
        steps,
        error,
      });
      const target = this.deps.settingsPath();
      if (!target) return fail('no_settings_path');
      const backup = this.backups.find((b) => b.id === id);
      if (!backup) return fail('not_found');
      let data: Buffer;
      try {
        data = await fsp.readFile(this.fileOf(backup));
      } catch (err) {
        steps.push({ id: 'read', ok: false, detail: (err as Error).message });
        return fail('not_found');
      }
      if (sha256(data) !== backup.hash) {
        steps.push({ id: 'read', ok: false, detail: 'content does not match its checksum' });
        return fail('damaged');
      }
      steps.push({ id: 'read', ok: true });

      // HQPlayer writes its settings when it quits, so it must be closed before the file is
      // replaced — otherwise it would overwrite the restored copy on exit.
      const wasRunning = await ctl.isRunning().catch(() => false);
      if (wasRunning) {
        await ctl.close().catch(() => undefined);
        const until = this.now() + (this.deps.closeTimeoutMs ?? 20_000);
        let running = true;
        while (this.now() < until) {
          running = await ctl.isRunning().catch(() => true);
          if (!running) break;
          await this.sleep(500);
        }
        if (running) {
          steps.push({ id: 'close', ok: false, detail: 'HQPlayer did not quit' });
          return fail('still_running');
        }
        steps.push({ id: 'close', ok: true });
        // let the file system settle after HQPlayer's last write
        await this.sleep(500);
      } else {
        steps.push({ id: 'close', ok: true, detail: 'was not running' });
      }

      const current = await this.takeCopy('before-restore').catch(() => null);
      steps.push({
        id: 'keep-current',
        ok: true,
        detail: current ? current.id : 'no current file (or same as a copy)',
      });

      try {
        await fsp.mkdir(posixOrWinDir(target), { recursive: true });
        const tmp = `${target}.hqps-restore.tmp`;
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, target);
        steps.push({ id: 'write', ok: true });
      } catch (err) {
        steps.push({ id: 'write', ok: false, detail: (err as Error).message });
        if (wasRunning) await ctl.start().catch(() => undefined);
        return fail('write_failed');
      }
      this.resetWarning = null;
      await this.save();

      if (wasRunning) {
        try {
          await ctl.start();
          steps.push({ id: 'start', ok: true });
        } catch (err) {
          steps.push({ id: 'start', ok: false, detail: (err as Error).message });
        }
      } else {
        steps.push({ id: 'start', ok: true, detail: 'left closed (was not running)' });
      }
      return { ok: true, backupId: id, steps };
    });
  }
}

/** Folder of a settings path, whichever separator it uses. */
function posixOrWinDir(path: string): string {
  return path.includes('\\') ? win32.dirname(path) : posix.dirname(path);
}
