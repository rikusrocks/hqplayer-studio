/**
 * Bridge exposed by the Electron preload script (contextIsolation on, no Node in the renderer).
 * Absent when the UI runs in a normal browser — always feature-detect.
 */
import type { HqpAppPrefs, HqpAppState } from '../main/hqplayer-app';

export interface StudioShell {
  isElectron: true;
  platform: string;
  toggleMiniPlayer(): void;
  showMainWindow(): void;
  closeMiniPlayer(): void;
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
  /** Start / show / hide HQPlayer Desktop (Windows). */
  hqplayerApp: {
    get(): Promise<HqpAppState | null>;
    set(patch: Partial<HqpAppPrefs>): Promise<HqpAppState | null>;
    launch(): Promise<HqpAppState | null>;
    window(action: 'show' | 'hide' | 'minimize'): Promise<HqpAppState | null>;
    pickExe(): Promise<HqpAppState | null>;
    /** What the latest start / hide runs did, without folders or window titles. */
    diagnostics(): Promise<unknown>;
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
