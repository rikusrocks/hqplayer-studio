/**
 * HQPlayer Studio — Electron main process.
 *
 * Hosts Studio Core in-process on 127.0.0.1 and loads the renderer from it (same origin, CSP
 * header from Core). The renderer has no Node access; the only bridge is the preload's
 * `window.studioShell`. Audio never passes through this app: HQPlayer keeps the whole chain.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { canUse, type EngineCapabilities, type EngineCapabilityKey } from '@hqps/contracts';
import { bootstrapStudio, type Bootstrapped } from '@hqps/core';
import { CapabilityUnavailableError } from '@hqps/hqplayer-adapter';
import { legacyDecodingAvailable } from '@hqps/library';
import {
  normalizeShellPrefs,
  shellLocaleOf,
  syncMediaKeys,
  trayMenuModel,
  trayTooltip,
  type MediaAction,
  type MediaKeyState,
  type ShellLocale,
  type ShellPrefs,
  type TrayItemId,
} from './desktop-shell';
import {
  defaultDetectDeps,
  detectHqplayerExe,
  ensureHqplayer,
  findHqplayerProcess,
  launchHqplayer,
  listProcesses,
  normalizePrefs,
  probeControlPort,
  processNameOf,
  processPath,
  rememberReport,
  reportsForDiagnostics,
  resolveHqplayerExe,
  shortError,
  windowControl,
  type HqpAppPrefs,
  type HqpAppState,
  type HqpExeResolution,
  type HqpRunReport,
  type HqpRunTrigger,
  type HqpWindowAction,
  type HqpWindowInfo,
} from './hqplayer-app';
import {
  fitToDisplays,
  loadWindowState,
  restoreBounds,
  sameBounds,
  saveWindowState,
  validateBounds,
  type WindowState,
} from './window-state';

const SMOKE = process.argv.includes('--smoke-test');
/** Launch override (`--adapter=live|mock` or STUDIO_ADAPTER); otherwise the saved preference. */
const ADAPTER: 'mock' | 'live' | undefined = process.argv.includes('--adapter=live')
  ? 'live'
  : process.argv.includes('--adapter=mock')
    ? 'mock'
    : process.env.STUDIO_ADAPTER === 'live' || process.env.STUDIO_ADAPTER === 'mock'
      ? process.env.STUDIO_ADAPTER
      : undefined;
const distDir = join(import.meta.dirname, '..');

let studio: Bootstrapped | null = null;
let baseUrl = '';
let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let windowState: WindowState = {};
let stateFile = '';
/** Set once quitting starts, so "close to tray" does not swallow the final close. */
let quitting = false;

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => showMain());

function workAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

const secureWebPreferences = () => ({
  preload: join(import.meta.dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
});

function createMainWindow(): BrowserWindow {
  const saved = restoreBounds(windowState.main, workAreas(), 'main');
  const win = new BrowserWindow({
    ...(saved ?? { width: 1280, height: 820 }),
    minWidth: 720,
    minHeight: 480,
    title: 'HQPlayer Studio',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: secureWebPreferences(),
  });
  if (windowState.main?.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!SMOKE) win.show();
  });
  const remember = () => {
    if (win.isDestroyed()) return;
    windowState.main = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveWindowState(stateFile, windowState);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', (event) => {
    // Tray + "keep running": hide instead of quitting, so playback control and the Web Remote
    // stay available. Quit from the tray menu.
    if (!quitting && tray && shellPrefs().closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    mainWindow = null;
    miniWindow?.close();
  });
  win.on('restore', () => revalidateWindows());
  // Windows logoff/shutdown: never let "close to tray" hold it up.
  win.on('session-end', () => {
    quitting = true;
  });
  void win.loadURL(`${baseUrl}/`);
  return win;
}

function createMiniWindow(): BrowserWindow {
  const saved = restoreBounds(windowState.mini, workAreas(), 'mini');
  const win = new BrowserWindow({
    ...(saved ?? { width: 380, height: 132 }),
    minWidth: 300,
    minHeight: 110,
    maxHeight: 220,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: windowState.miniAlwaysOnTop ?? true,
    title: 'HQPlayer Studio — Mini',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: secureWebPreferences(),
  });
  win.once('ready-to-show', () => win.show());
  const remember = () => {
    if (win.isDestroyed()) return;
    windowState.mini = win.getBounds();
    saveWindowState(stateFile, windowState);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('closed', () => {
    miniWindow = null;
    updateTray();
  });
  void win.loadURL(`${baseUrl}/#/mini`);
  return win;
}

function toggleMini(): void {
  if (miniWindow) {
    miniWindow.close();
    showMain();
  } else {
    miniWindow = createMiniWindow();
    mainWindow?.minimize();
  }
  updateTray();
}

/**
 * Monitors were added, removed, rearranged or rescaled: bring windows back onto a display.
 * The Mini Player is kept fully on one screen; the main window only when mostly off-screen.
 */
let revalidateTimer: ReturnType<typeof setTimeout> | null = null;
function revalidateWindows(): void {
  if (revalidateTimer) clearTimeout(revalidateTimer);
  revalidateTimer = setTimeout(() => {
    revalidateTimer = null;
    const areas = workAreas();
    for (const [win, kind] of [
      [mainWindow, 'main'],
      [miniWindow, 'mini'],
    ] as const) {
      if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) continue;
      if (win.isFullScreen()) continue;
      const b = win.getBounds();
      const next = kind === 'main' && validateBounds(b, areas) ? b : fitToDisplays(b, areas);
      if (!sameBounds(b, next)) win.setBounds(next);
    }
  }, 300);
}

function showMain(): void {
  if (!mainWindow) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ------------------------------------------------------------------ media keys & tray

const SHELL_SETTING = 'desktop.shell';
let shellLocale: ShellLocale = 'en';
let mediaKeyState: MediaKeyState = {
  supported: false,
  enabled: false,
  registered: [],
  unavailable: [],
};
let tray: Tray | null = null;
let lastCapabilities: EngineCapabilities | null = null;
let lastMediaNoticeAt = 0;

function shellPrefs(): ShellPrefs {
  return normalizeShellPrefs(studio?.ctx.settings.get(SHELL_SETTING, null));
}

/** Media keys act through the same checked engine commands as the buttons in the app. */
async function onMediaAction(action: MediaAction): Promise<void> {
  if (!studio) return;
  try {
    await studio.server.engine.transport(action);
  } catch (err) {
    // Tell the user once in a while (e.g. control switched off) instead of failing silently.
    if (Date.now() - lastMediaNoticeAt < 15_000) return;
    lastMediaNoticeAt = Date.now();
    const off = err instanceof CapabilityUnavailableError;
    studio.server.hub.notice(
      'warning',
      off ? 'media_key_control_off' : 'media_key_failed',
      off
        ? 'Media key ignored: Studio may not control HQPlayer (Settings → Playback).'
        : 'Media key ignored: HQPlayer did not accept the command.',
    );
  }
}

function applyMediaKeys(): void {
  // Global media keys are a Windows feature here (macOS would need accessibility permission).
  mediaKeyState = syncMediaKeys(
    globalShortcut,
    shellPrefs().mediaKeys && !SMOKE,
    (action) => void onMediaAction(action),
    process.platform === 'win32',
  );
}

function trayIcon(): Electron.NativeImage {
  const base = nativeImage.createFromPath(join(distDir, 'remote', 'icon-192.png'));
  if (base.isEmpty()) return base;
  const img = nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor);
    img.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: base.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    });
  }
  return img;
}

function usable(key: EngineCapabilityKey): boolean {
  const status = studio?.server.engine.getStatus();
  return status?.connection === 'connected' && canUse(lastCapabilities, key);
}

function onTrayItem(id: TrayItemId): void {
  const engine = studio?.server.engine;
  if (!engine) return;
  if (id === 'toggle') void onMediaAction('toggle');
  else if (id === 'next' || id === 'previous') void onMediaAction(id);
  else if (id === 'mini') toggleMini();
  else if (id === 'show') {
    miniWindow?.close();
    showMain();
  } else if (id === 'quit') app.quit();
}

function updateTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const status = studio?.server.engine.getStatus();
  const playing = status?.transport === 'playing';
  const state = {
    locale: shellLocale,
    title: status?.track?.title ?? null,
    artist: status?.track?.artist ?? null,
    playing,
    can: {
      toggle: usable(playing ? 'transport.pause' : 'transport.play'),
      next: usable('transport.next'),
      previous: usable('transport.previous'),
    },
    miniOpen: miniWindow !== null,
  };
  const template: MenuItemConstructorOptions[] = trayMenuModel(state).map((item) =>
    item.type === 'separator'
      ? { type: 'separator' }
      : {
          label: item.label,
          type: item.type === 'checkbox' ? 'checkbox' : 'normal',
          enabled: item.enabled ?? true,
          checked: item.checked,
          click: item.id ? () => onTrayItem(item.id!) : undefined,
        },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(trayTooltip(state));
}

let trayTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTrayUpdate(): void {
  if (!tray || trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    updateTray();
  }, 250);
}

function applyTray(): void {
  const want = shellPrefs().tray && !SMOKE;
  if (want && !tray) {
    tray = new Tray(trayIcon());
    // Windows: a click opens Studio; the menu is on right-click.
    tray.on('click', () => {
      miniWindow?.close();
      showMain();
    });
    updateTray();
  } else if (!want && tray) {
    tray.destroy();
    tray = null;
    // Without a tray icon a hidden main window would be unreachable.
    if (mainWindow && !mainWindow.isVisible()) showMain();
  }
}

function shellState() {
  return {
    prefs: shellPrefs(),
    mediaKeys: mediaKeyState,
    tray: { supported: !SMOKE, active: tray !== null },
  };
}

function registerShellIpc(): void {
  ipcMain.handle('studio:shell:get', (event) => (fromStudio(event) ? shellState() : null));
  ipcMain.handle('studio:shell:set', (event, patch: unknown) => {
    if (!fromStudio(event) || !studio) return null;
    const next = normalizeShellPrefs({ ...shellPrefs(), ...(patch as object) });
    studio.ctx.settings.set(SHELL_SETTING, next);
    applyMediaKeys();
    applyTray();
    return shellState();
  });
  ipcMain.on('studio:set-locale', (event, locale: unknown) => {
    if (!fromStudio(event) || typeof locale !== 'string') return;
    shellLocale = shellLocaleOf(locale);
    updateTray();
  });
}

function startShellIntegration(): void {
  if (!studio) return;
  shellLocale = shellLocaleOf(app.getLocale());
  void studio.server.engine.getCapabilities().then((c) => {
    lastCapabilities = c;
    scheduleTrayUpdate();
  });
  studio.server.hub.subscribe((event) => {
    if (event.type === 'engine.capabilities') {
      lastCapabilities = event.capabilities;
      scheduleTrayUpdate();
    } else if (event.type === 'engine.status') {
      scheduleTrayUpdate();
      hqpOnEngineConnection(event.status.connection === 'connected');
    }
  });
  applyMediaKeys();
  applyTray();
  for (const e of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
    screen.on(e as 'display-added', () => revalidateWindows());
  }
}

/** Only accept IPC from our own pages. */
function fromStudio(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return baseUrl !== '' && url.startsWith(`${baseUrl}/`);
}

function registerIpc(): void {
  ipcMain.on('studio:toggle-mini', (event) => {
    if (!fromStudio(event)) return;
    toggleMini();
  });
  ipcMain.handle('studio:get-always-on-top', (event) =>
    fromStudio(event) ? (windowState.miniAlwaysOnTop ?? true) : true,
  );
  ipcMain.on('studio:relaunch', (event) => {
    if (!fromStudio(event) || SMOKE) return;
    // Portable builds run from a temp copy that is deleted on exit: relaunch the original .exe.
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    app.relaunch(portable ? { execPath: portable, args: [] } : undefined);
    app.quit();
  });
  ipcMain.on('studio:show-main', (event) => {
    if (!fromStudio(event)) return;
    miniWindow?.close();
    showMain();
  });
  ipcMain.on('studio:close-mini', (event) => {
    if (!fromStudio(event)) return;
    miniWindow?.close();
  });
  ipcMain.handle('studio:set-always-on-top', (event, on: unknown) => {
    if (!fromStudio(event)) return false;
    const value = on === true;
    windowState.miniAlwaysOnTop = value;
    saveWindowState(stateFile, windowState);
    miniWindow?.setAlwaysOnTop(value);
    return value;
  });
  ipcMain.handle('studio:pick-folder', async (event) => {
    if (!fromStudio(event)) return null;
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts = { title: 'Choose a music folder', properties: ['openDirectory' as const] };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
}

// ------------------------------------------------------------------ HQPlayer program (Windows)

const HQP_APP_SETTING = 'hqplayer.app';
/** Where HQPlayer was last seen running: Studio's own note, used when detection finds nothing. */
const HQP_SEEN_SETTING = 'hqplayer.app.seen';
let hqpDetection: { at: number; result: HqpExeResolution } | null = null;
/** What the latest runs did, newest first (kept in memory; shown in Settings and diagnostics). */
let hqpReports: HqpRunReport[] = [];
/** The window watcher that is running now, and the window list it saw last. */
let hqpWatch: { cancelled: boolean } | null = null;
let hqpWatchWindows: HqpWindowInfo[] | null = null;
let hqpEngineConnected = false;

function hqpPrefs(): HqpAppPrefs {
  return normalizePrefs(studio?.ctx.settings.get(HQP_APP_SETTING, null));
}

/** Detection is cached; a miss is retried after half a minute (HQPlayer may get installed). */
async function hqpDetect(): Promise<HqpExeResolution> {
  const stale = !hqpDetection?.result.exePath && Date.now() - (hqpDetection?.at ?? 0) > 30_000;
  const gone = hqpDetection?.result.exePath && !existsSync(hqpDetection.result.exePath);
  if (!hqpDetection || stale || gone) {
    const readShortcut = (lnk: string) => shell.readShortcutLink(lnk).target || null;
    hqpDetection = {
      at: Date.now(),
      result: await detectHqplayerExe(defaultDetectDeps(readShortcut)),
    };
  }
  return hqpDetection.result;
}

function hqpResolveExe(prefs = hqpPrefs()): Promise<HqpExeResolution> {
  return resolveHqplayerExe({
    preferred: prefs.exePath,
    exists: existsSync,
    detect: hqpDetect,
    remembered: () => {
      const seen = studio?.ctx.settings.get(HQP_SEEN_SETTING, null);
      return typeof seen === 'string' && seen ? seen : null;
    },
    remember: (path) => studio?.ctx.settings.set(HQP_SEEN_SETTING, path),
    listProcesses,
    processPath,
  });
}

async function hqpState(): Promise<HqpAppState> {
  const prefs = hqpPrefs();
  const state: HqpAppState = {
    supported: process.platform === 'win32',
    prefs,
    exePath: null,
    exeSource: null,
    searched: [],
    running: false,
    runningError: null,
    windows: [],
    windowsError: null,
    reports: hqpReports,
  };
  if (!state.supported) return state;
  const exe = await hqpResolveExe(prefs);
  state.exePath = exe.exePath;
  state.exeSource = exe.source;
  state.searched = exe.searched;
  let image: string | null = exe.exePath;
  try {
    const proc = findHqplayerProcess(await listProcesses(), exe.exePath);
    state.running = proc !== null;
    if (proc) image = proc.image;
  } catch (err) {
    // no process list: fall back to "is HQPlayer's control port answering?"
    state.runningError = shortError(err);
    state.running = await probeControlPort();
  }
  if (!state.running || !image) return state;
  if (hqpWatch && hqpWatchWindows) {
    state.windows = hqpWatchWindows; // the watcher is polling already
    return state;
  }
  try {
    state.windows = (await windowControl(processNameOf(image), 'list')).windows;
  } catch (err) {
    state.windowsError = shortError(err);
  }
  return state;
}

/**
 * Start HQPlayer if asked and needed, then put its windows where the user wants them. Resolves
 * once the program is found / started; the window watcher goes on in the background and updates
 * the same report. A newer run (or a manual show / hide) replaces a watcher that is still going.
 */
async function hqpEnsure(
  trigger: HqpRunTrigger,
  launchIfStopped: boolean,
): Promise<HqpRunReport | null> {
  if (process.platform !== 'win32') return null;
  const prefs = hqpPrefs();
  if (hqpWatch) hqpWatch.cancelled = true;
  const cancel = { cancelled: false };
  hqpWatch = cancel;
  hqpWatchWindows = null;
  const release = () => {
    if (hqpWatch !== cancel) return;
    hqpWatch = null;
    hqpWatchWindows = null;
  };
  try {
    const { report, settled } = await ensureHqplayer(
      { trigger, launchIfStopped, windowMode: prefs.windowMode, cancel },
      {
        resolveExe: () => hqpResolveExe(prefs),
        listProcesses,
        probeEngine: () => probeControlPort(),
        launch: (exe, o) => launchHqplayer(exe, o, { spawn, openPath: shell.openPath }),
        control: (name, action) => windowControl(name, action),
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onWindows: (r) => {
          if (hqpWatch === cancel) hqpWatchWindows = r.windows;
        },
        onReport: (r) => {
          // "HQPlayer connected" checks that found nothing to do are not worth a line
          if (r.trigger === 'connected' && r.process.status !== 'running') return;
          hqpReports = rememberReport(hqpReports, r);
        },
      },
    );
    hqpNotify(report, 'process');
    void settled.then((final) => {
      release();
      hqpNotify(final, 'window');
    });
    return report;
  } catch (err) {
    release();
    throw err;
  }
}

/** Resolves when the main window can show a toast (set at startup). */
let hqpToastReady: Promise<void> = Promise.resolve();

/** Tell the user when a start they asked for did not happen, or the window could not be hidden. */
function hqpNotify(report: HqpRunReport, step: 'process' | 'window'): void {
  const notice = (code: string, message: string, error?: string) =>
    void hqpToastReady.then(() =>
      studio?.server.hub.notice('warning', code, message, error ? { error } : undefined),
    );
  if (step === 'process' && report.process.status === 'no-exe') {
    notice(
      'hqp_app_not_found',
      'HQPlayer was not started: Studio could not find the program (Settings → Playback).',
    );
  } else if (step === 'process' && report.process.status === 'start-failed') {
    const error = report.process.error ?? 'unknown error';
    notice('hqp_app_start_failed', `HQPlayer could not be started: ${error}`, error);
  } else if (step === 'window' && report.window.status === 'failed') {
    const error = report.window.error ?? 'unknown error';
    notice(
      'hqp_app_window_failed',
      `HQPlayer's window could not be hidden or minimized: ${error}`,
      error,
    );
  }
}

/** Start HQPlayer with Studio (opt-in), or tidy its window away if it is already running. */
async function hqpStartup(): Promise<void> {
  const prefs = hqpPrefs();
  if (process.platform !== 'win32') return;
  if (!prefs.autoStart && prefs.windowMode === 'normal') return;
  await hqpEnsure('startup', prefs.autoStart);
}

/**
 * HQPlayer's control connection came up: if it was started after Studio (by the user, or it
 * simply took long), put its window where the user wants it now.
 */
function hqpOnEngineConnection(connected: boolean): void {
  const cameUp = connected && !hqpEngineConnected;
  hqpEngineConnected = connected;
  if (!cameUp || process.platform !== 'win32') return;
  if (hqpPrefs().windowMode === 'normal' || hqpWatch) return; // nothing to do / already watching
  void hqpEnsure('connected', false).catch(() => undefined);
}

function registerHqplayerIpc(): void {
  ipcMain.handle('studio:hqp-app:get', async (event) => (fromStudio(event) ? hqpState() : null));
  ipcMain.handle('studio:hqp-app:set', async (event, patch: unknown) => {
    if (!fromStudio(event) || !studio) return null;
    const before = hqpPrefs();
    const next = normalizePrefs({ ...before, ...(patch as object) });
    studio.ctx.settings.set(HQP_APP_SETTING, next);
    // a new window mode applies to a running HQPlayer right away (it never starts it)
    if (next.windowMode !== before.windowMode) {
      if (next.windowMode === 'normal') {
        if (hqpWatch) hqpWatch.cancelled = true;
      } else {
        await hqpEnsure('settings', false);
      }
    }
    return hqpState();
  });
  ipcMain.handle('studio:hqp-app:launch', async (event) => {
    if (!fromStudio(event)) return null;
    await hqpEnsure('manual', true);
    return hqpState();
  });
  ipcMain.handle('studio:hqp-app:window', async (event, action: unknown) => {
    if (!fromStudio(event)) return null;
    const allowed: HqpWindowAction[] = ['show', 'hide', 'minimize'];
    if (!allowed.includes(action as HqpWindowAction)) return hqpState();
    // the user's own show / hide wins over a watcher that is still tidying up after a start
    if (hqpWatch) hqpWatch.cancelled = true;
    hqpWatch = null;
    hqpWatchWindows = null;
    const exe = await hqpResolveExe();
    const proc = findHqplayerProcess(await listProcesses().catch(() => []), exe.exePath);
    const image = proc?.image ?? exe.exePath;
    if (image) await windowControl(processNameOf(image), action as HqpWindowAction);
    return hqpState();
  });
  ipcMain.handle('studio:hqp-app:diagnostics', (event) =>
    fromStudio(event)
      ? {
          supported: process.platform === 'win32',
          autoStart: hqpPrefs().autoStart,
          windowMode: hqpPrefs().windowMode,
          customPath: hqpPrefs().exePath !== null,
          reports: reportsForDiagnostics(hqpReports),
        }
      : null,
  );
  ipcMain.handle('studio:hqp-app:pick-exe', async (event) => {
    if (!fromStudio(event) || !studio) return null;
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const opts = {
      title: 'Choose HQPlayer Desktop (.exe)',
      properties: ['openFile' as const],
      filters: [{ name: 'Programs', extensions: ['exe'] }],
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    const picked = res.canceled ? null : (res.filePaths[0] ?? null);
    if (picked) studio.ctx.settings.set(HQP_APP_SETTING, { ...hqpPrefs(), exePath: picked });
    return hqpState();
  });
}

function lockDown(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${baseUrl}/`)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

async function startCore(): Promise<Bootstrapped> {
  const opts = {
    dataDir: join(app.getPath('userData'), SMOKE ? 'smoke-data' : 'data'),
    appVersion: app.getVersion(),
    adapter: SMOKE ? 'mock' : ADAPTER,
    staticDirs: { desktop: join(distDir, 'renderer'), remote: join(distDir, 'remote') },
    demo: true,
    resetData: SMOKE,
  };
  try {
    return await bootstrapStudio({ ...opts, port: 47321 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return bootstrapStudio({ ...opts, port: 0 }); // another instance / dev server owns 47321
  }
}

async function runSmokeTest(): Promise<void> {
  const timer = setTimeout(() => {
    console.error('SMOKE_FAIL timeout');
    if (process.env.STUDIO_SMOKE_OUT)
      writeFileSync(process.env.STUDIO_SMOKE_OUT, 'SMOKE_FAIL timeout\n');
    app.exit(1);
  }, 45_000);
  const win = mainWindow as BrowserWindow;
  await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
  await new Promise((r) => setTimeout(r, 1500));
  const page = (await win.webContents.executeJavaScript(
    'JSON.stringify({ shell: Boolean(window.studioShell && window.studioShell.isElectron), nodeLeak: typeof window.require !== "undefined" || typeof window.process !== "undefined", title: document.title, text: document.body.innerText.length })',
  )) as string;
  const health = (await (await fetch(`${baseUrl}/api/v1/health`)).json()) as Record<
    string,
    unknown
  >;
  const albums = (await (await fetch(`${baseUrl}/api/v1/library/albums?limit=1`)).json()) as {
    total: number;
  };
  // Phase 4: online lyrics are opt-in (off on a fresh install); the lyrics service works in the
  // packaged app (demo tracks get invented demo lyrics, never anything online).
  const lyricsSettings = (await (await fetch(`${baseUrl}/api/v1/settings/lyrics`)).json()) as {
    online: boolean;
  };
  const someTrack = (await (await fetch(`${baseUrl}/api/v1/library/tracks?limit=1`)).json()) as {
    items: { id: string }[];
  };
  const lyrics = someTrack.items[0]
    ? ((await (
        await fetch(`${baseUrl}/api/v1/tracks/${encodeURIComponent(someTrack.items[0].id)}/lyrics`)
      ).json()) as { state: string; source: string | null })
    : null;
  const remote = await fetch(`${baseUrl}/remote/`);
  // Phase 3: the LAN listener must be off on a fresh install (handoff §12.3).
  const lan = (await (await fetch(`${baseUrl}/api/v1/remote/settings`)).json()) as {
    state: string;
  };
  const result = {
    page: JSON.parse(page),
    health,
    albums: albums.total,
    remoteStatus: remote.status,
    lanState: lan.state,
    lyricsOnline: lyricsSettings.online,
    lyrics: lyrics ? `${lyrics.state}/${lyrics.source}` : null,
    sqlite: process.versions.sqlite ?? 'builtin',
    // GBK / Shift-JIS tag recovery needs full ICU in Electron's Node
    legacyDecoding: legacyDecodingAvailable(),
  };
  const ok =
    result.page.shell === true &&
    result.page.nodeLeak === false &&
    health.ok === true &&
    albums.total > 0 &&
    remote.status === 200 &&
    lan.state === 'off' &&
    lyricsSettings.online === false &&
    result.lyrics === 'found/demo' &&
    result.legacyDecoding;
  const line = `${ok ? 'SMOKE_OK' : 'SMOKE_FAIL'} ${JSON.stringify(result)}`;
  console.log(line);
  // GUI-subsystem builds on Windows may not have a console: also write the result to a file.
  if (process.env.STUDIO_SMOKE_OUT) writeFileSync(process.env.STUDIO_SMOKE_OUT, `${line}\n`);
  clearTimeout(timer);
  await studio?.server.close();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(async () => {
  stateFile = join(app.getPath('userData'), 'window-state.json');
  windowState = loadWindowState(stateFile);
  lockDown();
  registerIpc();
  registerHqplayerIpc();
  registerShellIpc();
  try {
    studio = await startCore();
  } catch (err) {
    dialog.showErrorBox(
      'HQPlayer Studio',
      `Studio Core failed to start:\n${(err as Error).message}`,
    );
    app.exit(1);
    return;
  }
  baseUrl = studio.url;
  mainWindow = createMainWindow();
  if (SMOKE) {
    await runSmokeTest();
    return;
  }
  startShellIntegration();
  const win = mainWindow;
  // Failures are also shown as a toast in the main window: wait until it can show one.
  hqpToastReady = new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => setTimeout(resolve, 2500));
    setTimeout(resolve, 20_000);
  });
  // Nothing in here throws: every outcome ends up in the report shown in Settings.
  void hqpStartup().catch((err: unknown) => console.error('HQPlayer startup step failed:', err));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});

app.on('activate', () => {
  if (studio && !mainWindow) mainWindow = createMainWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', (event) => {
  if (quitting || !studio) return;
  event.preventDefault();
  quitting = true;
  tray?.destroy();
  tray = null;
  void studio.server.close().finally(() => {
    studio?.ctx.close();
    app.quit();
  });
});
