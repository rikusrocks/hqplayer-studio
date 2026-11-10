/**
 * Sandboxed preload. Exposes exactly the `StudioShell` interface declared in
 * src/renderer/shell.ts — nothing else (no ipcRenderer, no Node APIs).
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('studioShell', {
  isElectron: true as const,
  platform: process.platform,
  toggleMiniPlayer: (): void => ipcRenderer.send('studio:toggle-mini'),
  showMainWindow: (): void => ipcRenderer.send('studio:show-main'),
  closeMiniPlayer: (): void => ipcRenderer.send('studio:close-mini'),
  getAlwaysOnTop: (): Promise<boolean> =>
    ipcRenderer.invoke('studio:get-always-on-top') as Promise<boolean>,
  setLocale: (locale: string): void => ipcRenderer.send('studio:set-locale', String(locale)),
  desktop: {
    get: () => ipcRenderer.invoke('studio:shell:get'),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('studio:shell:set', patch),
  },
  relaunch: (): void => ipcRenderer.send('studio:relaunch'),
  setAlwaysOnTop: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('studio:set-always-on-top', on === true) as Promise<boolean>,
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('studio:pick-folder') as Promise<string | null>,
  hqplayerApp: {
    get: () => ipcRenderer.invoke('studio:hqp-app:get'),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke('studio:hqp-app:set', patch),
    launch: () => ipcRenderer.invoke('studio:hqp-app:launch'),
    window: (action: 'show' | 'hide' | 'minimize') =>
      ipcRenderer.invoke('studio:hqp-app:window', action),
    pickExe: () => ipcRenderer.invoke('studio:hqp-app:pick-exe'),
    diagnostics: () => ipcRenderer.invoke('studio:hqp-app:diagnostics'),
  },
});
