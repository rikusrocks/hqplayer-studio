/**
 * Bridge exposed by the Electron preload script (contextIsolation on, no Node in the renderer).
 * Absent when the UI runs in a normal browser — always feature-detect.
 */
export interface StudioShell {
  isElectron: true;
  platform: string;
  toggleMiniPlayer(): void;
  showMainWindow(): void;
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
  };
}

export interface HqpAppPrefs {
  exePath: string | null;
  autoStart: boolean;
  windowMode: 'normal' | 'minimized' | 'hidden';
}

export interface HqpAppState {
  supported: boolean;
  prefs: HqpAppPrefs;
  exePath: string | null;
  running: boolean;
  windows: { handle: number; title: string; className: string; visible: boolean }[];
}

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
