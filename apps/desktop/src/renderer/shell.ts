/**
 * Bridge exposed by the Electron preload script (contextIsolation on, no Node in the renderer).
 * Absent when the UI runs in a normal browser — always feature-detect.
 */
export interface StudioShell {
  isElectron: true;
  platform: string;
  toggleMiniPlayer(): void;
  showMainWindow(): void;
  setAlwaysOnTop(on: boolean): Promise<boolean>;
  pickFolder(): Promise<string | null>;
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
