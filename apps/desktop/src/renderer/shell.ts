/**
 * Bridge exposed by the Electron preload script (contextIsolation on, no Node in the renderer).
 * Absent when the UI runs in a normal browser — always feature-detect.
 */
import type { HqpAppPrefs, HqpAppState } from '../main/hqplayer-app';
import type { HqpSettingsBackupState, RestoreReport } from '../main/hqp-settings-backup';

export interface StudioShell {
  isElectron: true;
  platform: string;
  toggleMiniPlayer(): void;
  showMainWindow(): void;
  closeMiniPlayer(): void;
  /**
   * The side panel (queue / lyrics) opened or closed: the window grows by `width` px on its
   * right edge, or gives that back, so the panel never covers the content. Resolves to whether
   * the window is extended (false when it is maximized: the content makes room instead).
   */
  setSidePanel(open: boolean, width: number): Promise<boolean>;
  /** Saved “always on top” of the Mini Player. */
  getAlwaysOnTop(): Promise<boolean>;
  /** Tray menu labels follow the UI language. */
  setLocale(locale: string): void;
  /** Media keys & tray icon (Settings → 常规). */
  desktop: {
    get(): Promise<DesktopShellState | null>;
    set(patch: Partial<DesktopShellPrefs>): Promise<DesktopShellState | null>;
  };
  /** Restart the app (used after changing the engine adapter). */
  relaunch(): void;
  setAlwaysOnTop(on: boolean): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  /** Open one of Studio's own folders in Explorer: '' when it opened, otherwise the error. */
  openFolder(which: 'logs' | 'backups' | 'soak' | 'hqp-settings'): Promise<string>;
  /**
   * Copies of HQPlayer's own settings file (devices, buffer, input, volume, DSP …). Absent in an
   * older desktop app. Restore closes HQPlayer, writes the copy and starts HQPlayer again.
   */
  hqplayerSettings?: {
    get(): Promise<HqpSettingsBackupState | null>;
    backupNow(): Promise<HqpSettingsBackupState | null>;
    pin(id: string, pinned: boolean): Promise<HqpSettingsBackupState | null>;
    dismiss(): Promise<HqpSettingsBackupState | null>;
    restore(id: string): Promise<RestoreReport | null>;
  };
  /** Start / show / hide HQPlayer Desktop (Windows). */
  hqplayerApp: {
    get(): Promise<HqpAppState | null>;
    set(patch: Partial<HqpAppPrefs>): Promise<HqpAppState | null>;
    launch(): Promise<HqpAppState | null>;
    window(action: 'show' | 'hide' | 'minimize'): Promise<HqpAppState | null>;
    pickExe(): Promise<HqpAppState | null>;
    /** What the latest start / hide runs did, without folders or window titles. */
    diagnostics(): Promise<unknown>;
    /** Does HQPlayer's control port 127.0.0.1:4321 answer? (connects and disconnects, sends nothing) */
    probe(): Promise<boolean>;
  };
}

export interface DesktopShellPrefs {
  mediaKeys: boolean;
  tray: boolean;
  closeToTray: boolean;
}

export interface DesktopShellState {
  prefs: DesktopShellPrefs;
  mediaKeys: { supported: boolean; enabled: boolean; registered: string[]; unavailable: string[] };
  tray: { supported: boolean; active: boolean };
}

// Types only: nothing from the main process is bundled into the renderer.
export type { HqpAppPrefs, HqpAppState, HqpRunReport, HqpSearchStep } from '../main/hqplayer-app';
export type {
  HqpSettingsBackup,
  HqpSettingsBackupState,
  RestoreReport,
} from '../main/hqp-settings-backup';

declare global {
  interface Window {
    studioShell?: StudioShell;
  }
}

export function getShell(): StudioShell | null {
  return typeof window !== 'undefined' && window.studioShell?.isElectron
    ? window.studioShell
    : null;
}
