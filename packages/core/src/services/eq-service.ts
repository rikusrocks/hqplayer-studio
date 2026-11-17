import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EQ_MAX_PROFILES,
  EqConfigSchema,
  EqFileInfoSchema,
  EqProfileSchema,
  EqReloadCheckSchema,
  FLAT_EQ,
  type DspState,
  type EqCheckStart,
  type EqConfig,
  type EqFileInfo,
  type EqProfile,
  type EqReloadCheck,
  type EqStatus,
} from '@hqps/contracts';
import { CapabilityUnavailableError, EngineCommandError } from '@hqps/hqplayer-adapter';
import type { SettingsRepository } from '@hqps/library';
import { HttpError } from '../http/errors';
import { isLoopbackHost } from '../http/security';
import type { StudioLog } from '../logging/studio-log';
import { EQ_CHECK_CONFIG, buildEqImpulse, encodeFloatWav } from './eq-filter';
import type { EngineService } from './engine-service';

export const EQ_CONFIG_SETTING = 'eq.config';
export const EQ_PROFILES_SETTING = 'eq.profiles';
export const EQ_FILE_SETTING = 'eq.file';
export const EQ_RELOAD_CHECK_SETTING = 'eq.reloadCheck';
export const EQ_FILE_NAME = 'studio-eq.wav';

export interface EqServiceOptions {
  /** Folder of the filter file (`<data>/eq`); null = Studio cannot write one (tests, demo). */
  dir: string | null;
  /** Where HQPlayer runs: on another computer it must reach the file itself. */
  hqplayerHost: string;
  log?: StudioLog;
  /** The listening check puts the user's EQ back by itself after this long. */
  checkTimeoutMs?: number;
}

/**
 * Studio EQ (D-043). HQPlayer has no EQ commands, so Studio writes the curve as an impulse
 * response WAV to one fixed file that the user points HQPlayer's convolution at once (Studio
 * never edits HQPlayer's configuration). Afterwards:
 *
 *  - saving the EQ rewrites the file; when Studio may switch convolution and it is on, it is
 *    switched off before the write (the file may be held open) and on again after it, which is
 *    what makes HQPlayer load the new filter (if it does — the listening check finds out);
 *  - convolution on/off goes through the verified DSP path (`setDsp`, read back from State),
 *    so it needs both control switches and is offered on this computer only.
 */
export class EqService {
  private check: { restoreConvolution: boolean; timer: ReturnType<typeof setTimeout> } | null =
    null;

  constructor(
    private readonly engine: EngineService,
    private readonly settings: SettingsRepository,
    private readonly opts: EqServiceOptions,
  ) {}

  get filePath(): string | null {
    return this.opts.dir ? join(this.opts.dir, EQ_FILE_NAME) : null;
  }

  config(): EqConfig {
    const parsed = EqConfigSchema.safeParse(this.settings.get<unknown>(EQ_CONFIG_SETTING, null));
    return parsed.success ? parsed.data : FLAT_EQ;
  }

  profiles(): EqProfile[] {
    const raw = this.settings.get<unknown[]>(EQ_PROFILES_SETTING, []);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((p) => {
      const parsed = EqProfileSchema.safeParse(p);
      return parsed.success ? [parsed.data] : [];
    });
  }

  private fileInfo(): EqFileInfo | null {
    const parsed = EqFileInfoSchema.safeParse(this.settings.get<unknown>(EQ_FILE_SETTING, null));
    return parsed.success && parsed.data.path === this.filePath ? parsed.data : null;
  }

  private reloadCheck(): EqReloadCheck | null {
    const parsed = EqReloadCheckSchema.safeParse(
      this.settings.get<unknown>(EQ_RELOAD_CHECK_SETTING, null),
    );
    return parsed.success ? parsed.data : null;
  }

  private canSwitch(): boolean {
    return this.engine.adapter.isConnected() && this.engine.can('dsp.write');
  }

  /** HQPlayer's convolution switch, or null when it cannot be read right now. */
  private async convolution(): Promise<boolean | null> {
    if (!this.engine.adapter.isConnected() || !this.engine.can('dsp.read')) return null;
    try {
      return (await this.readDsp()).selected?.convolution ?? null;
    } catch {
      return null;
    }
  }

  async status(): Promise<EqStatus> {
    return {
      config: this.config(),
      profiles: this.profiles(),
      filePath: this.filePath,
      file: this.fileInfo(),
      convolution: await this.convolution(),
      canSwitch: this.canSwitch(),
      hqplayerRemote: !isLoopbackHost(this.opts.hqplayerHost),
      reloadCheck: this.reloadCheck(),
      checkRunning: this.check !== null,
    };
  }

  /** Save the curve and write the file (HQPlayer reloads it when convolution is on). */
  async save(config: EqConfig): Promise<EqStatus> {
    if (this.check) throw checkBusy();
    const parsed = EqConfigSchema.parse(config);
    this.settings.set(EQ_CONFIG_SETTING, parsed);
    await this.writeAndReload(parsed);
    this.opts.log?.info('eq', 'EQ saved', { bands: parsed.bands.length });
    return this.status();
  }

  async setConvolution(enabled: boolean): Promise<EqStatus> {
    if (this.check) throw checkBusy();
    this.engine.require('dsp.write');
    // HQPlayer should find a file at the path from the start
    if (enabled && !this.fileInfo()) this.writeFile(this.config());
    await this.switchConvolution(enabled);
    return this.status();
  }

  saveProfile(name: string, config: EqConfig): EqProfile[] {
    const profiles = this.profiles();
    const existing = profiles.find((p) => p.name === name);
    const profile: EqProfile = {
      id: existing?.id ?? `eq_${randomUUID()}`,
      name,
      createdAt: Date.now(),
      config: EqConfigSchema.parse(config),
    };
    const next = existing
      ? profiles.map((p) => (p.id === existing.id ? profile : p))
      : [...profiles, profile];
    if (next.length > EQ_MAX_PROFILES) {
      throw new HttpError(409, 'conflict', `At most ${EQ_MAX_PROFILES} EQ curves can be saved`);
    }
    this.settings.set(EQ_PROFILES_SETTING, next);
    return next;
  }

  removeProfile(id: string): EqProfile[] {
    const next = this.profiles().filter((p) => p.id !== id);
    this.settings.set(EQ_PROFILES_SETTING, next);
    return next;
  }

  // --- the listening check ----------------------------------------------------------------------

  /**
   * Put a strong treble cut (it only ever lowers the level) into the file and switch convolution
   * off and on. If HQPlayer will not switch convolution on, no filter is set up there. Otherwise
   * the user says whether the music now sounds muffled; the answer (or a timeout) puts their own
   * EQ back.
   */
  async startCheck(): Promise<EqCheckStart> {
    if (this.check) throw checkBusy();
    this.engine.require('dsp.write');
    const before = await this.convolution();
    this.writeFile(EQ_CHECK_CONFIG, { remember: false });
    try {
      await this.switchConvolution(false);
      await this.switchConvolution(true);
    } catch (err) {
      this.writeFile(this.config());
      if (err instanceof HttpError && reasonOf(err) === 'eq_not_configured') {
        this.record('not-configured');
        return { started: false, status: await this.status() };
      }
      throw err;
    }
    const timer = setTimeout(() => {
      void this.finishCheck(null).catch((e: unknown) =>
        this.opts.log?.warn('eq', 'listening check: restoring the EQ failed', {
          error: (e as Error).message,
        }),
      );
    }, this.opts.checkTimeoutMs ?? 120_000);
    timer.unref?.();
    this.check = { restoreConvolution: before === true, timer };
    this.opts.log?.info('eq', 'listening check started');
    return { started: true, status: await this.status() };
  }

  /** The user's answer (null: cancelled / timed out). Puts their EQ back either way. */
  async finishCheck(heard: boolean | null): Promise<EqStatus> {
    const check = this.check;
    if (!check) throw new HttpError(409, 'conflict', 'No EQ listening check is running');
    clearTimeout(check.timer);
    this.check = null;
    if (heard !== null) this.record(heard ? 'reloads' : 'no-reload');
    try {
      await this.switchConvolution(false);
      this.writeFile(this.config());
      if (check.restoreConvolution) await this.switchConvolution(true);
    } catch (err) {
      // still put the user's curve in the file, even if HQPlayer could not be switched
      this.writeFile(this.config());
      throw err;
    }
    return this.status();
  }

  /** Quitting during a listening check: at least put the user's curve back in the file. */
  dispose(): void {
    if (!this.check) return;
    clearTimeout(this.check.timer);
    this.check = null;
    try {
      this.writeFile(this.config());
    } catch {
      // HQPlayer holds the file; it keeps the test filter until the next save
    }
  }

  // --- internals --------------------------------------------------------------------------------

  private record(result: EqReloadCheck['result']): void {
    this.settings.set(EQ_RELOAD_CHECK_SETTING, { result, at: Date.now() });
    this.opts.log?.info('eq', 'listening check result', { result });
  }

  private async writeAndReload(config: EqConfig): Promise<void> {
    const cycle = this.canSwitch() && (await this.convolution()) === true;
    if (!cycle) {
      this.writeFile(config);
      return;
    }
    await this.switchConvolution(false);
    try {
      this.writeFile(config);
    } finally {
      await this.switchConvolution(true);
    }
  }

  private writeFile(config: EqConfig, opts: { remember?: boolean } = {}): void {
    const path = this.filePath;
    if (!path || !this.opts.dir) {
      throw new HttpError(409, 'conflict', 'Studio has no folder for the EQ file here');
    }
    const imp = buildEqImpulse(config);
    const wav = encodeFloatWav(imp.samples, imp.sampleRate);
    mkdirSync(this.opts.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, wav);
      try {
        renameSync(tmp, path);
      } catch {
        // Windows refuses to replace a file another program has open; try writing in place
        writeFileSync(path, wav);
        rmSync(tmp, { force: true });
      }
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new HttpError(
        409,
        'conflict',
        `Studio could not write the EQ file (${(err as NodeJS.ErrnoException).code ?? 'error'}). ` +
          'If HQPlayer is using it, turn convolution off and try again.',
        { reason: 'eq_file_busy' },
      );
    }
    if (opts.remember === false) return;
    const info: EqFileInfo = {
      path,
      writtenAt: Date.now(),
      sampleRate: imp.sampleRate,
      taps: imp.taps,
      preampDb: imp.preampDb,
      peakDb: imp.peakDb,
      tailDb: imp.tailDb,
    };
    this.settings.set(EQ_FILE_SETTING, info);
  }

  private async switchConvolution(enabled: boolean): Promise<void> {
    try {
      await this.engine.run('setDsp', (a) => {
        if (!a.setDsp)
          throw new CapabilityUnavailableError('dsp.write', 'adapter cannot change DSP');
        return a.setDsp({ convolution: enabled });
      });
    } catch (err) {
      if (enabled && err instanceof EngineCommandError && /did not apply/.test(err.message)) {
        throw new HttpError(
          409,
          'conflict',
          'HQPlayer did not turn convolution on: no convolution filter is set up in HQPlayer yet. ' +
            'Choose the Studio EQ file in HQPlayer’s convolution settings first.',
          { reason: 'eq_not_configured' },
        );
      }
      throw err;
    }
  }

  private readDsp(): Promise<DspState> {
    return this.engine.run('getDspState', (a) => {
      if (!a.getDspState)
        throw new CapabilityUnavailableError('dsp.read', 'adapter cannot read DSP state');
      return a.getDspState();
    });
  }
}

function reasonOf(err: HttpError): string | null {
  const d = err.details as { reason?: unknown } | undefined;
  return typeof d?.reason === 'string' ? d.reason : null;
}

function checkBusy(): HttpError {
  return new HttpError(
    409,
    'conflict',
    'An EQ listening check is running; answer or cancel it first',
  );
}
