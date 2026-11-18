/**
 * HQPlayer Studio — Electron main process.
 *
 * Hosts Studio Core in-process on 127.0.0.1 and loads the renderer from it (same origin, CSP
 * header from Core). The renderer has no Node access; the only bridge is the preload's
 * `window.studioShell`. Audio never passes through this app: HQPlayer keeps the whole chain.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { bootstrapStudio, FileLog, installCrashHandlers, type Bootstrapped } from '@hqps/core';
import { CapabilityUnavailableError } from '@hqps/hqplayer-adapter';
import {
  DatabaseTooNewError,
  SUPPORTED_SCHEMA_VERSION,
  legacyDecodingAvailable,
  listBackups,
  requestRestore,
} from '@hqps/library';
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
import { defaultSettingsPath, HqpSettingsBackups } from './hqp-settings-backup';
import {
  fitToDisplays,
  growForPanel,
  loadWindowState,
  restoreBounds,
  sameBounds,
  saveWindowState,
  shrinkAfterPanel,
  validateBounds,
  type PanelGrowth,
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
/** Studio's data: database, artwork cache, backups (`<userData>/data`). */
const dataDir = join(app.getPath('userData'), SMOKE ? 'smoke-data' : 'data');
/** Folders the user can open from Settings (never a path that came from the page). */
const FOLDERS = {
  logs: join(app.getPath('userData'), SMOKE ? 'smoke-logs' : 'logs'),
  backups: join(dataDir, 'backups'),
  soak: join(app.getPath('userData'), SMOKE ? 'smoke-soak-reports' : 'soak-reports'),
  'hqp-settings': join(
    app.getPath('userData'),
    SMOKE ? 'smoke-hqplayer-settings' : 'hqplayer-settings-backups',
  ),
} as const;
type FolderId = keyof typeof FOLDERS;

let studio: Bootstrapped | null = null;
let baseUrl = '';
let mainWindow: BrowserWindow | null = null;
/** How far the main window is currently extended for the side panel (queue / lyrics). */
let panelGrowth: PanelGrowth | null = null;
const MAIN_MIN_WIDTH = 720;
let miniWindow: BrowserWindow | null = null;
let windowState: WindowState = {};
let stateFile = '';
/** Set once quitting starts, so "close to tray" does not swallow the final close. */
let quitting = false;

/** A second copy only hands over to the first one (and must not start Core or a log session). */
const primary = SMOKE || app.requestSingleInstanceLock();
if (!primary) app.quit();

/**
 * Local log + crash reports (Phase 5): one privacy-filtered file shared with Core, in
 * `<userData>/logs`. Nothing is uploaded; Settings → 诊断 opens the folder.
 */
const log = new FileLog({
  dir: FOLDERS.logs,
  appVersion: app.getVersion(),
  // Studio's own install folder becomes "<app>" in stack traces; other paths are removed.
  appRoots: [app.getAppPath(), process.resourcesPath, dirname(process.execPath)].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  ),
});
if (primary) {
  log.startSession();
  log.info('app', 'starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    smoke: SMOKE || undefined,
  });
  installCrashHandlers(log, {
    // Like Electron's default, keep running; tell the user once where the details are.
    onUncaught: (_err, report) => {
      studio?.server.hub.notice(
        'error',
        'internal_error',
        'An internal error occurred in HQP Studio. Details were saved to the log folder (Settings → Diagnostics).',
        report ? { report } : undefined,
      );
    },
  });
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
    minWidth: MAIN_MIN_WIDTH,
    minHeight: 480,
    title: 'HQP Studio',
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
    // Remember the size without the side panel's extension: the panel re-extends the window
    // when it opens, so the saved size must not grow by another panel on every launch.
    const normal = win.getNormalBounds();
    const base = panelGrowth ? shrinkAfterPanel(normal, panelGrowth, MAIN_MIN_WIDTH) : normal;
    windowState.main = { ...base, maximized: win.isMaximized() };
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
    panelGrowth = null;
    miniWindow?.close();
  });
  win.on('restore', () => revalidateWindows());
  win.on('unresponsive', () => log.warn('window', 'main window not responding'));
  win.on('responsive', () => log.info('window', 'main window responding again'));
  // Windows logoff/shutdown: never let "close to tray" hold it up, and do not report the
  // shutdown as a crash at the next start (Windows may end the process before "before-quit").
  win.on('session-end', () => {
    quitting = true;
    log.info('app', 'Windows is logging off or shutting down');
    log.endSession();
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
    title: 'HQP Studio — Mini',
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

/**
 * The side panel is appended to the window's right edge instead of covering the content: opening
 * it makes the window wider by the panel's width, closing it takes that width back. A maximized
 * or full-screen window cannot grow, so there the content makes room instead (returns false).
 */
function setSidePanel(win: BrowserWindow, open: boolean, width: number): boolean {
  const resizable = !win.isMaximized() && !win.isFullScreen() && !win.isMinimized();
  if (open) {
    if (panelGrowth) return true;
    const extra = Math.min(600, Math.max(0, Math.round(width)));
    if (!resizable || extra === 0) return false;
    const current = win.getBounds();
    const { bounds, growth } = growForPanel(
      current,
      extra,
      screen.getDisplayMatching(current).workArea,
    );
    if (growth.width === 0) return false;
    // Set before resizing: the resize handler saves the size without this extension.
    panelGrowth = growth;
    win.setBounds(bounds);
    return true;
  }
  const growth = panelGrowth;
  panelGrowth = null;
  if (!growth) return false;
  if (resizable) win.setBounds(shrinkAfterPanel(win.getBounds(), growth, MAIN_MIN_WIDTH));
  return false;
}

function registerIpc(): void {
  ipcMain.handle('studio:set-side-panel', (event, open: unknown, width: unknown) => {
    if (!fromStudio(event)) return false;
    const win = mainWindow;
    // only the main window's own page may resize it (not the Mini Player)
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    return setSidePanel(win, open === true, typeof width === 'number' ? width : 0);
  });
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
  ipcMain.handle('studio:open-folder', async (event, which: unknown) => {
    if (!fromStudio(event) || typeof which !== 'string' || !(which in FOLDERS)) return 'invalid';
    const dir = FOLDERS[which as FolderId];
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // openPath reports the problem
    }
    return shell.openPath(dir); // '' on success, otherwise Windows' error text
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
          logHqpReport(r);
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

/** One log line per start / hide run (statuses only; errors pass the privacy filter). */
const loggedHqpReports = new Map<number, string>();
function logHqpReport(r: HqpRunReport): void {
  const key = `${r.process.status}|${r.window.status}`;
  if (loggedHqpReports.get(r.id) === key) return;
  loggedHqpReports.set(r.id, key);
  if (loggedHqpReports.size > 50) loggedHqpReports.delete(loggedHqpReports.keys().next().value!);
  const failed =
    r.process.status === 'start-failed' ||
    r.process.status === 'no-exe' ||
    r.window.status === 'failed';
  (failed ? log.warn : log.info).call(log, 'hqplayer-app', `run ${r.trigger}`, {
    exe: r.exe.status,
    source: r.exe.source ?? undefined,
    process: r.process.status,
    method: r.process.method,
    window: r.window.status,
    mode: r.windowMode,
    error: r.process.error ?? r.window.error ?? undefined,
  });
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
  // HQPlayer (re)started: its settings file may have changed — or been reset
  if (cameUp) hqpSettingsCheckSoon();
  if (!cameUp || process.platform !== 'win32') return;
  if (hqpPrefs().windowMode === 'normal' || hqpWatch) return; // nothing to do / already watching
  void hqpEnsure('connected', false).catch(() => undefined);
}

// ------------------------------------------------------------------ HQPlayer settings backups

/** Copies of HQPlayer's own settings file (see hqp-settings-backup.ts). */
const hqpSettings = new HqpSettingsBackups({
  dir: FOLDERS['hqp-settings'],
  settingsPath: () => defaultSettingsPath(),
});
let hqpSettingsTimer: ReturnType<typeof setInterval> | null = null;

function hqpSettingsCheckSoon(delayMs = 3_000): void {
  setTimeout(() => {
    void hqpSettings
      .check()
      .then((s) => {
        if (s.resetWarning) {
          log.warn('hqp-settings', 'HQPlayer settings look reset', {
            current: s.resetWarning.currentId,
            good: s.resetWarning.goodId,
          });
        }
      })
      .catch((err: unknown) => log.warn('hqp-settings', 'check failed', { error: String(err) }));
  }, delayMs).unref?.();
}

function startHqpSettingsBackups(): void {
  hqpSettingsCheckSoon(1_000);
  // HQPlayer writes the file when its settings are saved and when it quits
  hqpSettingsTimer ??= setInterval(() => hqpSettingsCheckSoon(0), 5 * 60_000);
  hqpSettingsTimer.unref?.();
}

/** HQPlayer's process for the restore: is it running, close it the normal way, start it. */
const hqpProcessControl = {
  async isRunning(): Promise<boolean> {
    if (process.platform !== 'win32') return probeControlPort();
    const exe = await hqpResolveExe();
    try {
      return findHqplayerProcess(await listProcesses(), exe.exePath) !== null;
    } catch {
      return probeControlPort();
    }
  },
  async close(): Promise<void> {
    if (process.platform !== 'win32') return;
    if (hqpWatch) hqpWatch.cancelled = true;
    const exe = await hqpResolveExe();
    const proc = findHqplayerProcess(await listProcesses().catch(() => []), exe.exePath);
    const image = proc?.image ?? exe.exePath;
    if (image) await windowControl(processNameOf(image), 'close');
  },
  async start(): Promise<void> {
    if (process.platform !== 'win32') return;
    const report = await hqpEnsure('manual', true);
    if (
      report &&
      (report.process.status === 'start-failed' || report.process.status === 'no-exe')
    ) {
      throw new Error(`HQPlayer did not start (${report.process.status})`);
    }
  },
};

function registerHqpSettingsIpc(): void {
  ipcMain.handle('studio:hqp-settings:get', async (event) =>
    fromStudio(event) ? hqpSettings.state() : null,
  );
  ipcMain.handle('studio:hqp-settings:backup-now', async (event) =>
    fromStudio(event) ? hqpSettings.check('manual') : null,
  );
  ipcMain.handle('studio:hqp-settings:pin', async (event, id: unknown, pinned: unknown) =>
    fromStudio(event) && typeof id === 'string' ? hqpSettings.setPinned(id, pinned === true) : null,
  );
  ipcMain.handle('studio:hqp-settings:dismiss', async (event) =>
    fromStudio(event) ? hqpSettings.dismissWarning() : null,
  );
  ipcMain.handle('studio:hqp-settings:restore', async (event, id: unknown) => {
    if (!fromStudio(event) || typeof id !== 'string') return null;
    log.info('hqp-settings', 'restoring HQPlayer settings', { backup: id });
    const report = await hqpSettings.restore(id, hqpProcessControl);
    const steps = report.steps.map((x) => `${x.id}:${x.ok ? 'ok' : 'failed'}`).join(' ');
    if (report.ok) log.info('hqp-settings', 'restore finished', { steps });
    else log.warn('hqp-settings', 'restore failed', { error: report.error ?? null, steps });
    return report;
  });
}

function registerHqplayerIpc(): void {
  registerHqpSettingsIpc();
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
  // Setup wizard: is HQPlayer's control port (127.0.0.1:4321) answering? Only opens and closes a TCP connection.
  ipcMain.handle('studio:hqp-app:probe', async (event) =>
    fromStudio(event) ? probeControlPort(4321, 1500) : false,
  );
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
  // A crashed page is reloaded (a few times at most) instead of leaving a blank window.
  const reloads: number[] = [];
  app.on('render-process-gone', (_e, contents, details) => {
    const page = contents.getURL().includes('#/mini') ? 'mini player' : 'main window';
    log.crash('renderer-gone', {
      info: { page, reason: details.reason, exitCode: details.exitCode },
    });
    if (details.reason === 'clean-exit' || quitting || SMOKE) return;
    const now = Date.now();
    while (reloads.length && now - reloads[0]! > 10 * 60_000) reloads.shift();
    if (reloads.length >= 3) return;
    reloads.push(now);
    setTimeout(() => {
      if (!contents.isDestroyed()) contents.reload();
    }, 1000);
  });
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') return;
    log.crash('child-process-gone', {
      info: {
        type: details.type,
        name: details.name ?? undefined,
        reason: details.reason,
        exitCode: details.exitCode,
      },
    });
  });
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
    dataDir,
    appVersion: app.getVersion(),
    adapter: SMOKE ? 'mock' : ADAPTER,
    staticDirs: { desktop: join(distDir, 'renderer'), remote: join(distDir, 'remote') },
    demo: true,
    resetData: SMOKE,
    log,
    soakDir: FOLDERS.soak,
  };
  try {
    return await bootstrapStudio({ ...opts, port: 47321 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return bootstrapStudio({ ...opts, port: 0 }); // another instance / dev server owns 47321
  }
}

/**
 * The database was written by a newer Studio (the user went back to an older version). Nothing
 * was changed; offer the newest backup this version can read — normally the one the newer
 * version made right before it upgraded the database — and keep the newer data as a backup.
 */
async function offerOlderBackup(err: DatabaseTooNewError): Promise<boolean> {
  const zh = shellLocaleOf(app.getLocale()) === 'zh-CN';
  const usable = listBackups(FOLDERS.backups).filter(
    (b) => b.schemaVersion <= SUPPORTED_SCHEMA_VERSION,
  );
  const best = usable[0];
  log.warn('database', 'database is from a newer Studio', {
    dbVersion: err.dbVersion,
    supported: err.supportedVersion,
    usableBackups: usable.length,
  });
  const when = best ? new Date(best.createdAt).toLocaleString(app.getLocale()) : '';
  const kindZh: Record<string, string> = {
    'pre-migration': '升级前自动备份',
    daily: '每日自动备份',
    manual: '手动备份',
    'pre-restore': '恢复前的数据',
  };
  const message = zh
    ? '这个数据库来自更新版本的 HQP Studio'
    : 'This database is from a newer version of HQP Studio';
  const detail = zh
    ? `数据库版本 ${err.dbVersion}，此版本（${app.getVersion()}）只支持到 ${err.supportedVersion}。为避免损坏，数据库没有被打开或修改。

` +
      (best
        ? `可以恢复 ${when} 的备份（${kindZh[best.kind] ?? best.kind}，v${best.appVersion}）。当前数据库会先另存为备份，之后换回新版本时仍可恢复。`
        : '没有找到此版本可用的备份。请换回新版本，或打开备份文件夹查看。')
    : `Database version ${err.dbVersion}; this version (${app.getVersion()}) supports up to ${err.supportedVersion}. To avoid damage it was not opened or changed.

` +
      (best
        ? `You can restore the backup from ${when} (${best.kind}, v${best.appVersion}). The current database is kept as a backup first, so the newer version can still restore it later.`
        : 'No backup this version can use was found. Go back to the newer version, or open the backup folder.');
  const buttons = best
    ? zh
      ? ['恢复这个备份', '打开备份文件夹', '退出']
      : ['Restore this backup', 'Open backup folder', 'Quit']
    : zh
      ? ['打开备份文件夹', '退出']
      : ['Open backup folder', 'Quit'];
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'HQP Studio',
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  const choice = buttons[response];
  if (best && response === 0) {
    requestRestore(dataDir, FOLDERS.backups, best.id);
    log.warn('database', 'restoring an older backup after a version rollback', { backup: best.id });
    return true;
  }
  if (choice && choice !== buttons[buttons.length - 1]) await shell.openPath(FOLDERS.backups);
  return false;
}

async function startCoreOrExplain(): Promise<Bootstrapped | null> {
  let failure: unknown;
  try {
    return await startCore();
  } catch (err) {
    failure = err;
  }
  if (failure instanceof DatabaseTooNewError && !SMOKE) {
    if (!(await offerOlderBackup(failure))) return null;
    try {
      return await startCore();
    } catch (again) {
      failure = again;
    }
  }
  log.crash('core-start-failed', { error: failure });
  dialog.showErrorBox(
    'HQP Studio',
    `Studio Core failed to start:\n${log.redact((failure as Error).message)}\n\nDetails: ${FOLDERS.logs}`,
  );
  return null;
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
  // Phase 5: a backup from the worker thread (node:sqlite inside Electron's worker), the local
  // log, and a short soak-test run that writes its report.
  const post = (path: string, body: unknown = {}) =>
    fetch(`${baseUrl}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const backupRes = await post('/maintenance/backups');
  const backups = (await backupRes.json()) as { backups?: { kind: string; sizeBytes: number }[] };
  const logs = (await (await fetch(`${baseUrl}/api/v1/maintenance/logs`)).json()) as {
    enabled: boolean;
    files: { name: string }[];
  };
  await post('/maintenance/soak/start', { durationHours: null });
  const soak = (await (await post('/maintenance/soak/stop')).json()) as {
    reportFile: string | null;
  };
  const soakWritten = Boolean(soak.reportFile && existsSync(join(FOLDERS.soak, soak.reportFile)));
  const result = {
    page: JSON.parse(page),
    health,
    backup:
      backupRes.status === 200 && backups.backups?.[0]?.kind === 'manual'
        ? `${backups.backups[0].sizeBytes}B`
        : `failed (${backupRes.status})`,
    log: logs.enabled && logs.files.some((f) => f.name === 'studio.log'),
    soakReport: soakWritten,
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
    result.legacyDecoding &&
    result.backup.endsWith('B') &&
    result.log &&
    result.soakReport;
  const line = `${ok ? 'SMOKE_OK' : 'SMOKE_FAIL'} ${JSON.stringify(result)}`;
  console.log(line);
  // GUI-subsystem builds on Windows may not have a console: also write the result to a file.
  if (process.env.STUDIO_SMOKE_OUT) writeFileSync(process.env.STUDIO_SMOKE_OUT, `${line}\n`);
  clearTimeout(timer);
  await studio?.server.close();
  log.endSession();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(async () => {
  if (!primary) return;
  stateFile = join(app.getPath('userData'), 'window-state.json');
  windowState = loadWindowState(stateFile);
  lockDown();
  registerIpc();
  registerHqplayerIpc();
  registerShellIpc();
  studio = await startCoreOrExplain();
  if (!studio) {
    log.endSession();
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
  startHqpSettingsBackups();
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
  log.info('app', 'quitting');
  void studio.server.close().finally(() => {
    studio?.ctx.close();
    log.endSession();
    app.quit();
  });
});
