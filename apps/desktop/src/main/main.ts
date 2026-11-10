/**
 * HQPlayer Studio — Electron main process.
 *
 * Hosts Studio Core in-process on 127.0.0.1 and loads the renderer from it (same origin, CSP
 * header from Core). The renderer has no Node access; the only bridge is the preload's
 * `window.studioShell`. Audio never passes through this app: HQPlayer keeps the whole chain.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { bootstrapStudio, type Bootstrapped } from '@hqps/core';
import { legacyDecodingAvailable } from '@hqps/library';
import { loadWindowState, saveWindowState, validateBounds, type WindowState } from './window-state';

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
  const saved = validateBounds(windowState.main, workAreas());
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
  win.on('closed', () => {
    mainWindow = null;
    miniWindow?.close();
  });
  void win.loadURL(`${baseUrl}/`);
  return win;
}

function createMiniWindow(): BrowserWindow {
  const saved = validateBounds(windowState.mini, workAreas(), 40);
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
  });
  void win.loadURL(`${baseUrl}/#/mini`);
  return win;
}

function showMain(): void {
  if (!mainWindow) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Only accept IPC from our own pages. */
function fromStudio(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return baseUrl !== '' && url.startsWith(`${baseUrl}/`);
}

function registerIpc(): void {
  ipcMain.on('studio:toggle-mini', (event) => {
    if (!fromStudio(event)) return;
    if (miniWindow) {
      miniWindow.close();
      showMain();
    } else {
      miniWindow = createMiniWindow();
      mainWindow?.minimize();
    }
  });
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
  const remote = await fetch(`${baseUrl}/remote/`);
  const result = {
    page: JSON.parse(page),
    health,
    albums: albums.total,
    remoteStatus: remote.status,
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
  if (SMOKE) await runSmokeTest();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});

app.on('activate', () => {
  if (studio && !mainWindow) mainWindow = createMainWindow();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !studio) return;
  event.preventDefault();
  quitting = true;
  void studio.server.close().finally(() => {
    studio?.ctx.close();
    app.quit();
  });
});
