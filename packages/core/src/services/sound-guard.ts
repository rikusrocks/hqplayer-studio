import type {
  SoundDefaults,
  SoundGuard as SoundGuardState,
  UpdateSoundGuardRequest,
} from '@hqps/contracts';
import { ConflictError, type LibraryContext } from '@hqps/library';
import type { StudioLog } from '../logging/studio-log';
import { looksLikeVirtualCable } from './windows-media';
import {
  isSoundOutputId,
  SOUND_ROLES,
  type SoundOutputs,
  type SoundRole,
  type WindowsSound,
} from './windows-sound';

/** Switch by itself when the live input starts / ends (boolean, default false). */
export const SOUND_GUARD_AUTO_SETTING = 'appleMusic.guard.auto';
/** The everyday output the user picked (endpoint id or null). */
export const SOUND_GUARD_OUTPUT_SETTING = 'appleMusic.guard.outputId';
/** What Studio replaced and still has to put back (`{ at, previous }` or null). */
export const SOUND_GUARD_HELD_SETTING = 'appleMusic.guard.held';

type Held = NonNullable<SoundGuardState['held']>;

/**
 * Keeps other apps' sounds away from the DAC and the virtual cable by switching Windows'
 * default output to an everyday output the user picked, and putting the previous one back.
 *
 * Rules:
 * - Studio only ever switches TO the output the user chose; it never guesses one.
 * - What it replaced is written to the settings before the switch, so it can be put back after
 *   a crash or a restart.
 * - Putting back leaves alone whatever the user changed by hand in the meantime.
 * - A failure never stops the music: it is kept as text for the page.
 */
export class SoundGuard {
  private auto = false;
  private outputId: string | null = null;
  private held: Held | null = null;
  private snapshot: SoundOutputs | null = null;
  private error: string | null = null;
  /** One Windows call at a time: a "put back" must not overtake a switch that is under way. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sound: WindowsSound,
    private readonly settings: LibraryContext['settings'],
    private readonly log: StudioLog,
    private readonly changed: () => void,
  ) {}

  init(): void {
    this.auto = this.settings.get<boolean>(SOUND_GUARD_AUTO_SETTING, false) === true;
    const id = this.settings.get<string | null>(SOUND_GUARD_OUTPUT_SETTING, null);
    this.outputId = typeof id === 'string' && isSoundOutputId(id) ? id : null;
    this.held = readHeld(this.settings.get<unknown>(SOUND_GUARD_HELD_SETTING, null));
  }

  get(): SoundGuardState {
    return {
      supported: this.sound.supported,
      auto: this.auto,
      outputId: this.outputId,
      outputs:
        this.snapshot?.outputs.map((o) => ({ ...o, cable: looksLikeVirtualCable(o.name) })) ?? null,
      defaults: this.snapshot ? { ...this.snapshot.defaults } : null,
      held: this.held,
      error: this.error,
    };
  }

  /** Ask Windows which outputs exist and which one is the default. */
  refresh(): Promise<void> {
    return this.attempt(async () => {
      this.snapshot = await this.sound.read();
    });
  }

  async update(patch: UpdateSoundGuardRequest): Promise<void> {
    if (patch.outputId !== undefined) {
      if (patch.outputId !== null && !isSoundOutputId(patch.outputId))
        throw new ConflictError('That is not a Windows sound output.');
      this.outputId = patch.outputId;
      this.settings.set(SOUND_GUARD_OUTPUT_SETTING, patch.outputId);
    }
    if (patch.auto !== undefined) {
      this.auto = patch.auto;
      this.settings.set(SOUND_GUARD_AUTO_SETTING, patch.auto);
      this.log.info('apple-music', patch.auto ? 'sound guard: automatic' : 'sound guard: manual');
    }
    this.changed();
  }

  /** Make the chosen everyday output Windows' default (the button on the page). */
  protect(): Promise<void> {
    return this.attempt(() => this.doProtect());
  }

  /** Put back what Studio replaced (the button on the page). */
  restore(): Promise<void> {
    return this.attempt(() => this.doRestore());
  }

  /** The live input is starting. Never throws: a failure is kept for the page. */
  async liveStarted(): Promise<boolean> {
    if (!this.auto || !this.sound.supported) return true;
    return this.protect().then(
      () => true,
      () => false,
    );
  }

  /** The live input ended. Never throws. */
  async liveEnded(): Promise<boolean> {
    if (!this.auto || !this.held || !this.sound.supported) return true;
    return this.restore().then(
      () => true,
      () => false,
    );
  }

  private attempt(fn: () => Promise<void>): Promise<void> {
    const run = async () => {
      if (!this.sound.supported) throw new ConflictError('Only available on Windows.');
      try {
        await fn();
        this.error = null;
      } catch (err) {
        this.error = (err as Error).message.slice(0, 300);
        this.log.warn('apple-music', 'sound guard failed', { error: (err as Error).name });
        throw err instanceof ConflictError ? err : new ConflictError(this.error);
      } finally {
        this.changed();
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async doProtect(): Promise<void> {
    const target = this.outputId;
    if (!target) throw new ConflictError('Choose the everyday sound output first.');
    const now = await this.sound.read();
    this.snapshot = now;
    if (!now.outputs.some((o) => o.id === target))
      throw new ConflictError('The chosen sound output is not available in Windows right now.');
    const roles = SOUND_ROLES.filter((role) => now.defaults[role] !== target);
    if (roles.length === 0) return; // already where it should be
    if (!this.held) {
      // Written before the switch: after a crash the page can still put Windows back.
      this.held = { at: Date.now(), previous: { ...now.defaults } };
      this.settings.set(SOUND_GUARD_HELD_SETTING, this.held);
    }
    this.snapshot = await this.sound.setDefault(target, roles);
    const missed = SOUND_ROLES.filter((role) => this.snapshot?.defaults[role] !== target);
    if (missed.length > 0)
      throw new Error(`Windows did not switch its default output (${missed.join(', ')}).`);
    this.log.info('apple-music', 'sound guard: default output switched', { roles: roles.length });
  }

  private async doRestore(): Promise<void> {
    const held = this.held;
    if (!held) return;
    const now = await this.sound.read();
    this.snapshot = now;
    const byOutput = new Map<string, SoundRole[]>();
    for (const role of SOUND_ROLES) {
      const previous = held.previous[role];
      if (!previous || previous === now.defaults[role]) continue;
      // Changed by hand since Studio switched it: that choice stays.
      if (this.outputId && now.defaults[role] !== this.outputId) continue;
      // Unplugged or disabled since: nothing to go back to.
      if (!now.outputs.some((o) => o.id === previous)) continue;
      byOutput.set(previous, [...(byOutput.get(previous) ?? []), role]);
    }
    for (const [id, roles] of byOutput) this.snapshot = await this.sound.setDefault(id, roles);
    this.held = null;
    this.settings.set(SOUND_GUARD_HELD_SETTING, null);
    this.log.info('apple-music', 'sound guard: default output put back');
  }
}

function readHeld(value: unknown): Held | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { at?: unknown; previous?: unknown };
  if (typeof v.previous !== 'object' || v.previous === null) return null;
  const p = v.previous as Record<string, unknown>;
  const id = (x: unknown): string | null =>
    typeof x === 'string' && isSoundOutputId(x) ? x : null;
  const previous: SoundDefaults = {
    console: id(p.console),
    multimedia: id(p.multimedia),
    communications: id(p.communications),
  };
  return { at: typeof v.at === 'number' ? v.at : 0, previous };
}
