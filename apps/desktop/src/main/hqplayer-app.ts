/**
 * Starting HQPlayer Desktop from Studio and keeping its window out of the way (Windows only).
 *
 * Studio never changes HQPlayer's installation or settings: it only starts the program the user
 * already has, and shows / minimizes / hides its window with the standard Win32 ShowWindow call
 * (via PowerShell, so no native addon is needed). A hidden HQPlayer keeps running and playing;
 * Studio controls it over its API as usual, and "显示 HQPlayer" brings the window back.
 *
 * Every step reports what happened (`HqpRunReport`): where the program was looked for, whether it
 * was already running or had to be started, the start error, and what the window step did. The
 * steps are independent: whether HQPlayer runs is read from the process list (`tasklist`), so a
 * broken PowerShell can stop the window step but never the start.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

// HQPlayer is a Windows program: its paths are always Windows paths (also in tests on a Mac).
const { basename, dirname, join } = win32;

const execFileP = promisify(execFile);

export type HqpWindowMode = 'normal' | 'minimized' | 'hidden';
export type HqpWindowAction = 'list' | 'show' | 'hide' | 'minimize';

export interface HqpAppPrefs {
  /** HQPlayer Desktop's .exe; null = auto-detect. */
  exePath: string | null;
  /** Start HQPlayer when Studio starts (if it is not running yet). */
  autoStart: boolean;
  /** How Studio leaves HQPlayer's window when it starts it (or finds it running). */
  windowMode: HqpWindowMode;
}

export const DEFAULT_HQP_APP_PREFS: HqpAppPrefs = {
  exePath: null,
  autoStart: false,
  windowMode: 'normal',
};

export interface HqpWindowInfo {
  handle: number;
  /** Empty for a visible window without a title (listed so it can be hidden and diagnosed). */
  title: string;
  className: string;
  visible: boolean;
  minimized?: boolean;
  /** This call hid / minimized / showed the window. */
  changed?: boolean;
}

/** Where the executable came from. */
export type HqpExeSource =
  'preference' | 'registry' | 'shortcut' | 'folder' | 'remembered' | 'running';

/** One place Studio looked for HQPlayer, and what it found there (no private paths). */
export interface HqpSearchStep {
  where: HqpExeSource;
  result: 'found' | 'none' | 'missing' | 'error';
  /** Program names, counts or an error text. */
  detail?: string;
}

export interface HqpExeResolution {
  exePath: string | null;
  source: HqpExeSource | null;
  searched: HqpSearchStep[];
}

export type HqpRunTrigger = 'startup' | 'manual' | 'connected' | 'settings';

/** What one "start HQPlayer / tidy its window" run did, step by step. */
export interface HqpRunReport {
  id: number;
  /** Epoch ms when the run started. */
  at: number;
  trigger: HqpRunTrigger;
  /** Whether this run was allowed to start HQPlayer. */
  launchRequested: boolean;
  windowMode: HqpWindowMode;
  exe: {
    status: 'found' | 'not-found';
    source: HqpExeSource | null;
    path: string | null;
    searched: HqpSearchStep[];
  };
  process: {
    /**
     * running: already there · started: Studio started it · not-running: left alone (start not
     * requested) · no-exe: nothing to start · start-failed: Windows refused to start it.
     */
    status: 'running' | 'started' | 'not-running' | 'no-exe' | 'start-failed';
    /** Image name of the process (e.g. HQPlayer6Desktop.exe). */
    image: string | null;
    /** direct = started as a child process; shell = handed to Windows like a double click. */
    method?: 'direct' | 'shell';
    /** After a start: was the process seen in the process list? null = could not check. */
    seen?: boolean | null;
    /** The process list could not be read (the decision then used the control port). */
    checkError?: string;
    /** Start error text; with status "started" it is the error of the first, direct attempt. */
    error?: string;
  };
  window: {
    /**
     * skipped: nothing to do · watching: still running · done: windows handled (or none needed
     * it) · no-window: the program never showed a window · not-running: the program was gone ·
     * failed: the window tool failed · cancelled: replaced by a newer action.
     */
    status: 'skipped' | 'watching' | 'done' | 'no-window' | 'not-running' | 'failed' | 'cancelled';
    /** How many times a window was hidden / minimized. */
    changed: number;
    /** The windows that were hidden / minimized. */
    windows: { title: string; className: string }[];
    error?: string;
    ms?: number;
  };
}

export interface HqpAppState {
  supported: boolean;
  prefs: HqpAppPrefs;
  /** The executable Studio would start (preference or auto-detected). */
  exePath: string | null;
  exeSource: HqpExeSource | null;
  /** Where Studio looked for the executable. */
  searched: HqpSearchStep[];
  running: boolean;
  /** Set when the process list could not be read ("running" is then a guess). */
  runningError: string | null;
  windows: HqpWindowInfo[];
  /** Set when the window list could not be read. */
  windowsError: string | null;
  /** Outcome of the latest runs, newest first. */
  reports: HqpRunReport[];
}

export function normalizePrefs(value: unknown): HqpAppPrefs {
  const v = (value ?? {}) as Partial<HqpAppPrefs>;
  return {
    exePath: typeof v.exePath === 'string' && v.exePath.trim() ? v.exePath.trim() : null,
    autoStart: v.autoStart === true,
    windowMode: v.windowMode === 'hidden' || v.windowMode === 'minimized' ? v.windowMode : 'normal',
  };
}

// ------------------------------------------------------------------ small helpers

/** Windows' own tools by full path, so a damaged PATH cannot break them. */
function systemTool(name: string, sub = ''): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  const full = root ? join(root, 'System32', sub, name) : null;
  return full && existsSync(full) ? full : name;
}

/** `C:\Users\me\x\HQPlayer.exe` → `…\HQPlayer.exe`: error texts must not carry folder names. */
export function scrubPaths(text: string): string {
  return text.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)+/g, '…\\');
}

export function shortError(err: unknown, max = 300): string {
  const e = err as { code?: string | number; message?: string } | null;
  const message = (e?.message ?? String(err)).split(/\r?\n/)[0] ?? '';
  const text = scrubPaths(message).trim() || String(e?.code ?? 'failed');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ------------------------------------------------------------------ detection

/** `reg query …` output → one record per key: { '@key': path, Name: value, … }. */
export function parseRegQuery(output: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^HKEY_/i.test(line)) {
      current = { '@key': line };
      out.push(current);
      continue;
    }
    // an empty value has nothing after its type
    const m = /^\s+(.+?)\s{4}(REG_\w+)(?:\s{4}(.*))?$/.exec(line);
    if (m && current) current[m[1] as string] = m[3] ?? '';
  }
  return out;
}

export const isHqplayerExe = (name: string) =>
  /hqplayer/i.test(name) && /\.exe$/i.test(name) && !/unins|control|studio|client/i.test(name);

const desktopFirst = (a: string, b: string) =>
  Number(/desktop/i.test(b)) - Number(/desktop/i.test(a));

const isHqplayerProduct = (name: string) =>
  /hqplayer/i.test(name) && !/embedded|client|studio/i.test(name);

/** HQPlayer Desktop's executable from Windows "installed programs" entries. */
export function exeFromUninstallEntries(
  entries: Record<string, string>[],
  listDir: (dir: string) => string[] = safeListDir,
): string | null {
  const candidates = entries
    .filter((e) => isHqplayerProduct(e.DisplayName ?? ''))
    .sort((a, b) => desktopFirst(a.DisplayName ?? '', b.DisplayName ?? ''));
  for (const e of candidates) {
    const icon = (e.DisplayIcon ?? '').replace(/^"|"?(,\s*-?\d+)?$/g, '').trim();
    if (icon && isHqplayerExe(basename(icon))) return icon;
    const dir = (e.InstallLocation ?? '').replace(/^"|"$/g, '').trim();
    if (dir) {
      const exe = listDir(dir).filter(isHqplayerExe).sort(desktopFirst)[0];
      if (exe) return join(dir, exe);
    }
  }
  return null;
}

function safeListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // missing, or not a folder
  }
}

export interface DetectDeps {
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  /** Names in a folder; [] when it is missing or not a folder. */
  listDir(dir: string): string[];
  /** `reg query <args>` → stdout. Rejects with `code: 1` when nothing matched. */
  regQuery(args: string[]): Promise<string>;
  /** Target of a Windows shortcut (.lnk), or null. Electron provides it; absent in tests. */
  readShortcut?(lnkPath: string): string | null;
}

export const defaultDetectDeps = (
  readShortcut?: (lnkPath: string) => string | null,
): DetectDeps => ({
  env: process.env,
  exists: existsSync,
  listDir: safeListDir,
  regQuery: async (args) =>
    (
      await execFileP(systemTool('reg.exe'), ['query', ...args], {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout,
  ...(readShortcut ? { readShortcut } : {}),
});

const UNINSTALL_HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

async function detectFromRegistry(deps: DetectDeps): Promise<[string | null, HqpSearchStep]> {
  const names: string[] = [];
  const errors: string[] = [];
  for (const hive of UNINSTALL_HIVES) {
    let keys: string[];
    try {
      // "/f HQPlayer /d" only prints the values that contain "HQPlayer"; it is used to find the
      // keys, and each key is then read in full (an install folder need not contain the name).
      const out = await deps.regQuery([hive, '/s', '/f', 'HQPlayer', '/d']);
      keys = parseRegQuery(out).map((e) => e['@key'] as string);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 1) errors.push(shortError(err)); // 1 = no match
      continue;
    }
    const entries: Record<string, string>[] = [];
    for (const key of keys) {
      try {
        entries.push(...parseRegQuery(await deps.regQuery([key])).filter((e) => e.DisplayName));
      } catch (err) {
        errors.push(shortError(err));
      }
    }
    names.push(...entries.map((e) => e.DisplayName as string).filter(isHqplayerProduct));
    const found = exeFromUninstallEntries(entries, deps.listDir);
    if (found && deps.exists(found)) {
      return [found, { where: 'registry', result: 'found', detail: names.join('; ') }];
    }
  }
  if (names.length > 0) {
    // installed programs are listed, but none of them led to the .exe (typical for MSI entries)
    return [null, { where: 'registry', result: 'missing', detail: names.join('; ') }];
  }
  return [
    null,
    errors.length > 0
      ? { where: 'registry', result: 'error', detail: errors[0] as string }
      : { where: 'registry', result: 'none' },
  ];
}

/** Start-menu and desktop shortcuts named like HQPlayer → their target .exe. */
function detectFromShortcuts(deps: DetectDeps): [string | null, HqpSearchStep] {
  const read = deps.readShortcut;
  if (!read) return [null, { where: 'shortcut', result: 'none', detail: 'not available' }];
  const { env } = deps;
  const roots = [
    env.ProgramData && join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.APPDATA && join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.PUBLIC && join(env.PUBLIC, 'Desktop'),
    env.USERPROFILE && join(env.USERPROFILE, 'Desktop'),
  ].filter((r): r is string => Boolean(r));
  const links: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of deps.listDir(dir)) {
      if (/\.lnk$/i.test(name)) {
        if (isHqplayerProduct(name) && !/unins|manual|control/i.test(name)) {
          links.push(join(dir, name));
        }
      } else if (depth < 2) {
        walk(join(dir, name), depth + 1); // lists nothing when it is a file
      }
    }
  };
  for (const root of roots) walk(root, 0);
  links.sort((a, b) => desktopFirst(basename(a), basename(b)));
  for (const link of links) {
    let target: string | null = null;
    try {
      target = read(link);
    } catch {
      // unreadable shortcut
    }
    if (target && isHqplayerExe(basename(target)) && deps.exists(target)) {
      return [target, { where: 'shortcut', result: 'found', detail: `${links.length}` }];
    }
  }
  return [
    null,
    links.length > 0
      ? { where: 'shortcut', result: 'missing', detail: `${links.length}` }
      : { where: 'shortcut', result: 'none' },
  ];
}

/** `Program Files\Signalyst\*` and `Program Files\*HQPlayer*`. */
function detectFromFolders(deps: DetectDeps): [string | null, HqpSearchStep] {
  const { env } = deps;
  const bases = [
    ...new Set([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean)),
  ] as string[];
  let folders = 0;
  for (const base of bases) {
    const dirs = [
      ...deps.listDir(join(base, 'Signalyst')).map((sub) => join(base, 'Signalyst', sub)),
      ...deps
        .listDir(base)
        .filter((name) => /hqplayer/i.test(name))
        .map((name) => join(base, name)),
    ].sort((a, b) => desktopFirst(basename(a), basename(b)));
    for (const dir of dirs) {
      folders += 1;
      const exe = deps.listDir(dir).filter(isHqplayerExe).sort(desktopFirst)[0];
      if (exe) return [join(dir, exe), { where: 'folder', result: 'found' }];
    }
  }
  return [
    null,
    folders > 0
      ? { where: 'folder', result: 'missing', detail: `${folders}` }
      : { where: 'folder', result: 'none' },
  ];
}

/**
 * Looks for HQPlayer Desktop's executable: installed-programs registry entries, Start-menu /
 * desktop shortcuts, then the usual install folders. Reports every place it looked.
 */
export async function detectHqplayerExe(
  deps: DetectDeps = defaultDetectDeps(),
): Promise<HqpExeResolution> {
  const searched: HqpSearchStep[] = [];
  const steps: Array<
    [HqpExeSource, () => Promise<[string | null, HqpSearchStep]> | [string | null, HqpSearchStep]]
  > = [
    ['registry', () => detectFromRegistry(deps)],
    ['shortcut', () => detectFromShortcuts(deps)],
    ['folder', () => detectFromFolders(deps)],
  ];
  for (const [where, step] of steps) {
    try {
      const [path, record] = await step();
      searched.push(record);
      if (path) return { exePath: path, source: where, searched };
    } catch (err) {
      searched.push({ where, result: 'error', detail: shortError(err) });
    }
  }
  return { exePath: null, source: null, searched };
}

export interface ResolveDeps {
  /** The user's own choice (Settings → 选择 HQPlayer…), if any. */
  preferred: string | null;
  exists(path: string): boolean;
  detect(): Promise<HqpExeResolution>;
  /** Where HQPlayer was last seen running (Studio's own note). */
  remembered(): string | null;
  remember(path: string): void;
  listProcesses(): Promise<HqpProcess[]>;
  processPath(pid: number): Promise<string | null>;
}

/**
 * The executable Studio would start: the user's choice, else what detection finds, else where
 * HQPlayer was last seen running, else — if it is running right now — where that process lives
 * (which is then remembered, so starting it by hand once is enough to teach Studio).
 */
export async function resolveHqplayerExe(deps: ResolveDeps): Promise<HqpExeResolution> {
  const searched: HqpSearchStep[] = [];
  if (deps.preferred) {
    if (deps.exists(deps.preferred)) {
      searched.push({ where: 'preference', result: 'found' });
      return { exePath: deps.preferred, source: 'preference', searched };
    }
    searched.push({ where: 'preference', result: 'missing' }); // moved or uninstalled
  }
  try {
    const detected = await deps.detect();
    searched.push(...detected.searched);
    if (detected.exePath) return { exePath: detected.exePath, source: detected.source, searched };
  } catch (err) {
    searched.push({ where: 'registry', result: 'error', detail: shortError(err) });
  }
  const remembered = deps.remembered();
  if (remembered) {
    if (deps.exists(remembered)) {
      searched.push({ where: 'remembered', result: 'found' });
      return { exePath: remembered, source: 'remembered', searched };
    }
    searched.push({ where: 'remembered', result: 'missing' });
  }
  try {
    const proc = findHqplayerProcess(await deps.listProcesses(), null);
    if (!proc) {
      searched.push({ where: 'running', result: 'none' });
    } else {
      const path = await deps.processPath(proc.pid);
      if (path && isHqplayerExe(basename(path))) {
        deps.remember(path);
        searched.push({ where: 'running', result: 'found', detail: proc.image });
        return { exePath: path, source: 'running', searched };
      }
      // running, but Windows would not say where it lives (e.g. it runs as administrator)
      searched.push({ where: 'running', result: 'missing', detail: proc.image });
    }
  } catch (err) {
    searched.push({ where: 'running', result: 'error', detail: shortError(err) });
  }
  return { exePath: null, source: null, searched };
}

// ------------------------------------------------------------------ processes

export interface HqpProcess {
  image: string;
  pid: number;
}

/** `tasklist /FO CSV /NH` → processes. Other lines (e.g. a localized "no tasks") are ignored. */
export function parseTasklist(stdout: string): HqpProcess[] {
  const out: HqpProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) out.push({ image: m[1] as string, pid: Number(m[2]) });
  }
  return out;
}

/** All running processes, from Windows' `tasklist` (no PowerShell involved). */
export async function listProcesses(): Promise<HqpProcess[]> {
  const { stdout } = await execFileP(systemTool('tasklist.exe'), ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const list = parseTasklist(stdout);
  if (list.length === 0) throw new Error('tasklist returned no processes');
  return list;
}

/**
 * The running HQPlayer process: the configured executable's image name, or — so a second copy
 * is never started — any other process that looks like HQPlayer Desktop.
 */
export function findHqplayerProcess(list: HqpProcess[], exePath: string | null): HqpProcess | null {
  const image = exePath ? basename(exePath).toLowerCase() : null;
  const exact = image ? list.find((p) => p.image.toLowerCase() === image) : undefined;
  if (exact) return exact;
  return (
    list.filter((p) => isHqplayerExe(p.image)).sort((a, b) => desktopFirst(a.image, b.image))[0] ??
    null
  );
}

/** Is something listening on HQPlayer's control port? Used only when `tasklist` fails. */
export function probeControlPort(port = 4321, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Full path of a running process (plain PowerShell, no Add-Type); null when not readable. */
export async function processPath(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileP(
      systemTool('powershell.exe', 'WindowsPowerShell\\v1.0'),
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $env:HQPS_PID).Path'],
      { windowsHide: true, timeout: 20_000, env: { ...process.env, HQPS_PID: String(pid) } },
    );
    const path = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
    return /\.exe$/i.test(path) ? path : null;
  } catch {
    return null;
  }
}

export const processNameOf = (exePathOrImage: string) =>
  basename(exePathOrImage).replace(/\.exe$/i, '');

// ------------------------------------------------------------------ window control

/**
 * Lists / shows / hides / minimizes the top-level windows of a process. Parameters come from
 * environment variables (never interpolated into the script text).
 *   HQPS_PROC   process name without .exe
 *   HQPS_ACTION list | show | hide | minimize
 *   HQPS_SHOW   regex on "class|title" selecting which hidden windows "show" restores
 * Windows without a title are helpers and are left alone — except visible ones, which "hide"
 * hides too (a splash screen need not have a title) and "list" reports.
 * On failure it prints one line "HQPS_ERROR [<language mode>] <message>" and exits with 3.
 */
export const WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try {
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class HqpsWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static List<IntPtr> TopLevel(uint[] pids) {
    var found = new List<IntPtr>();
    var set = new HashSet<uint>(pids);
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (set.Contains(pid) && GetWindow(h, 4) == IntPtr.Zero) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
}
"@
$procs = @(Get-Process -Name $env:HQPS_PROC -ErrorAction SilentlyContinue)
$pids = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
$wins = @()
if ($pids.Count -gt 0) {
  foreach ($h in [HqpsWin]::TopLevel($pids)) {
    $title = [HqpsWin]::Text($h)
    $visible = [HqpsWin]::IsWindowVisible($h)
    if ($title.Length -eq 0 -and -not $visible) { continue }
    $cls = [HqpsWin]::Cls($h)
    $iconic = [HqpsWin]::IsIconic($h)
    $changed = $false
    switch ($env:HQPS_ACTION) {
      'hide' { if ($visible) { [void][HqpsWin]::ShowWindow($h, 0); $visible = $false; $changed = $true } }
      'minimize' {
        if ($visible -and -not $iconic -and $title.Length -gt 0) {
          [void][HqpsWin]::ShowWindow($h, 6); $iconic = $true; $changed = $true
        }
      }
      'show' {
        if ($title.Length -gt 0 -and "$cls|$title" -match $env:HQPS_SHOW) {
          [void][HqpsWin]::ShowWindow($h, 9); [void][HqpsWin]::ShowWindow($h, 5)
          [void][HqpsWin]::SetForegroundWindow($h); $visible = $true; $iconic = $false; $changed = $true
        }
      }
    }
    $wins += [pscustomobject]@{ handle = $h.ToInt64(); title = $title; className = $cls; visible = $visible; minimized = $iconic; changed = $changed }
  }
}
[pscustomobject]@{ pids = @($pids); windows = @($wins) } | ConvertTo-Json -Compress -Depth 4
} catch {
  $msg = [string]$_.Exception.Message
  $lang = ''
  try { $lang = [string]$ExecutionContext.SessionState.LanguageMode } catch { }
  Write-Output ("HQPS_ERROR [" + $lang + "] " + ($msg -replace '\s+', ' '))
  exit 3
}
`;

export interface WindowControlResult {
  pids: number[];
  windows: HqpWindowInfo[];
}

/** The useful part of a failed PowerShell call (never the encoded command itself). */
export function describeWindowError(
  err: { killed?: boolean; code?: string | number | null; stdout?: string; stderr?: string },
  timeoutMs: number,
): string {
  if (err.killed) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (err.code === 'ENOENT') return 'powershell.exe was not found';
  const marked = /HQPS_ERROR\s+(.*)/.exec(err.stdout ?? '')?.[1]?.trim();
  if (marked) return scrubPaths(marked).slice(0, 300);
  // PowerShell may serialise errors as CLIXML: drop the marker line and the tags
  const line = (err.stderr ?? '')
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/<[^>]+>/g, ' ')
        .replace(/_x000[DA]_/g, ' ')
        .trim(),
    )
    .find((l) => l && !l.startsWith('#<'));
  if (line) return scrubPaths(line).slice(0, 300);
  return err.code != null ? `PowerShell exited with code ${err.code}` : 'failed';
}

export async function windowControl(
  processName: string,
  action: HqpWindowAction,
  showMatch = 'QWindowIcon|HQPlayer',
  timeoutMs = 30_000,
): Promise<WindowControlResult> {
  if (process.platform !== 'win32') return { pids: [], windows: [] };
  const encoded = Buffer.from(WINDOW_SCRIPT, 'utf16le').toString('base64');
  let stdout: string;
  try {
    ({ stdout } = await execFileP(
      systemTool('powershell.exe', 'WindowsPowerShell\\v1.0'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-OutputFormat',
        'Text',
        '-EncodedCommand',
        encoded,
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        env: { ...process.env, HQPS_PROC: processName, HQPS_ACTION: action, HQPS_SHOW: showMatch },
      },
    ));
  } catch (err) {
    // keep the (huge) encoded command out of error messages and toasts
    const detail = describeWindowError(err as Parameters<typeof describeWindowError>[0], timeoutMs);
    throw new Error(`Window control (${action}) failed: ${detail}`, { cause: err });
  }
  let parsed: { pids?: number[] | number; windows?: HqpWindowInfo[] | HqpWindowInfo };
  try {
    parsed = JSON.parse(stdout.trim() || '{}') as typeof parsed;
  } catch {
    throw new Error(`Window control (${action}) failed: unreadable answer from PowerShell`);
  }
  const arr = <T>(v: T | T[] | undefined | null): T[] =>
    v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  return { pids: arr(parsed.pids), windows: arr(parsed.windows) };
}

// ------------------------------------------------------------------ starting HQPlayer

export interface HqpLaunchResult {
  ok: boolean;
  method: 'direct' | 'shell';
  /** Why it failed — or, when the shell fallback worked, why the direct start did not. */
  error?: string;
}

export interface LaunchDeps {
  spawn: (
    command: string,
    args: string[],
    options: { cwd: string; detached: boolean; stdio: 'ignore'; windowsHide: boolean },
  ) => Pick<ChildProcess, 'once' | 'unref'>;
  /** Electron's shell.openPath: starts it the way a double click does ('' = success). */
  openPath?: (path: string) => Promise<string>;
}

/**
 * Start HQPlayer (detached: it keeps running when Studio quits) and say whether Windows accepted
 * it. If the direct start is refused (for example the program needs elevation), Windows' shell
 * is asked to open it, exactly like a double click. `hidden` only passes Windows' standard
 * "start hidden" hint; programs are free to ignore it, so the window watcher still runs.
 */
export async function launchHqplayer(
  exePath: string,
  opts: { hidden?: boolean } = {},
  deps: LaunchDeps = { spawn },
): Promise<HqpLaunchResult> {
  const direct = await new Promise<string | null>((resolve) => {
    try {
      const child = deps.spawn(exePath, [], {
        cwd: dirname(exePath),
        detached: true,
        stdio: 'ignore',
        windowsHide: opts.hidden === true,
      });
      child.once('error', (err: Error) => resolve(shortError(err)));
      child.once('spawn', () => {
        child.unref();
        resolve(null);
      });
    } catch (err) {
      resolve(shortError(err));
    }
  });
  if (direct === null) return { ok: true, method: 'direct' };
  if (!deps.openPath) return { ok: false, method: 'direct', error: direct };
  let viaShell: string;
  try {
    viaShell = await deps.openPath(exePath);
  } catch (err) {
    viaShell = shortError(err);
  }
  if (viaShell === '') return { ok: true, method: 'shell', error: direct };
  return { ok: false, method: 'shell', error: `${direct}; ${scrubPaths(viaShell)}` };
}

// ------------------------------------------------------------------ window watcher

export interface WatchOptions {
  processName: string;
  mode: Exclude<HqpWindowMode, 'normal'>;
  /** Keep watching at least this long (a program that was just started is still loading). */
  minMs: number;
  /** Stop once nothing had to be hidden / minimized for this long. */
  settleMs: number;
  /** Give up after this long. */
  maxMs: number;
  pollMs: number;
  /** The program was just started: wait for its process instead of reporting "not running". */
  expectStart: boolean;
  cancel?: { cancelled: boolean };
}

export interface WatchDeps {
  control(processName: string, action: HqpWindowAction): Promise<WindowControlResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The latest window list, for the settings page. */
  onWindows?(result: WindowControlResult): void;
}

export type WatchResult = Omit<HqpRunReport['window'], 'status'> & {
  status: Exclude<HqpRunReport['window']['status'], 'skipped' | 'watching'>;
};

/**
 * Keeps HQPlayer's windows hidden / minimized while it starts up: every poll hides (minimizes)
 * whatever became visible — a splash screen first, the main window later — and it only stops
 * when nothing had to be changed for `settleMs` (and `minMs` have passed), or after `maxMs`.
 * Two failed polls in a row end it with the error text.
 */
export async function watchWindows(opts: WatchOptions, deps: WatchDeps): Promise<WatchResult> {
  const action: HqpWindowAction = opts.mode === 'hidden' ? 'hide' : 'minimize';
  const start = deps.now();
  const handled = new Map<number, { title: string; className: string }>();
  let changed = 0;
  let failures = 0;
  let seenProcess = false;
  let seenWindow = false;
  /** Since when nothing needed changing (null while the program has not shown up yet). */
  let quietSince: number | null = null;
  const end = (status: WatchResult['status'], error?: string): WatchResult => ({
    status,
    changed,
    windows: [...handled.values()],
    ms: deps.now() - start,
    ...(error ? { error } : {}),
  });
  for (;;) {
    if (opts.cancel?.cancelled) return end('cancelled');
    let result: WindowControlResult | null = null;
    try {
      result = await deps.control(opts.processName, action);
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= 2) return end('failed', shortError(err));
    }
    const now = deps.now();
    if (opts.cancel?.cancelled) return end('cancelled');
    if (result) {
      deps.onWindows?.(result);
      const acted = result.windows.filter((w) => w.changed);
      if (result.pids.length === 0) {
        // not there (yet), or it has exited
        if (seenProcess || !opts.expectStart) return end(changed > 0 ? 'done' : 'not-running');
      } else {
        seenProcess = true;
        if (result.windows.length > 0) seenWindow = true;
        if (acted.length > 0) {
          changed += acted.length;
          for (const w of acted) handled.set(w.handle, { title: w.title, className: w.className });
          quietSince = now;
        } else if (quietSince === null) {
          quietSince = now;
        }
      }
      if (quietSince !== null && now - quietSince >= opts.settleMs && now - start >= opts.minMs) {
        return end(changed > 0 || seenWindow ? 'done' : 'no-window');
      }
    }
    if (now - start >= opts.maxMs) {
      if (changed > 0 || seenWindow) return end('done');
      return end(seenProcess ? 'no-window' : 'not-running');
    }
    await deps.sleep(opts.pollMs);
  }
}

// ------------------------------------------------------------------ one run, step by step

export interface EnsureOptions {
  trigger: HqpRunTrigger;
  /** May this run start HQPlayer when it is not running? */
  launchIfStopped: boolean;
  windowMode: HqpWindowMode;
  /** Overrides for the watcher timing (tests). */
  watch?: Partial<Pick<WatchOptions, 'minMs' | 'settleMs' | 'maxMs' | 'pollMs'>>;
  cancel?: { cancelled: boolean };
}

export interface EnsureDeps extends WatchDeps {
  resolveExe(): Promise<HqpExeResolution>;
  listProcesses(): Promise<HqpProcess[]>;
  /** Is HQPlayer's control port answering? Asked only when the process list fails. */
  probeEngine(): Promise<boolean>;
  launch(exePath: string, opts: { hidden: boolean }): Promise<HqpLaunchResult>;
  /** Called whenever the report changes (the window step finishes later than the rest). */
  onReport?(report: HqpRunReport): void;
}

export interface EnsureResult {
  /**
   * The report once the program is found / started. Its window step may still be "watching":
   * the same object is updated when that step ends.
   */
  report: HqpRunReport;
  /** The final report, when the window step has ended. Never rejects. */
  settled: Promise<HqpRunReport>;
}

/** Timing of the window watcher: patient after a start, short when HQPlayer was already up. */
export const WATCH_AFTER_START = { minMs: 30_000, settleMs: 10_000, maxMs: 90_000, pollMs: 700 };
export const WATCH_RUNNING = { minMs: 0, settleMs: 6_000, maxMs: 20_000, pollMs: 700 };

let nextReportId = 1;

/**
 * Finds HQPlayer, starts it if asked and needed, then (independently) puts its windows where the
 * user wants them. Nothing here throws: every outcome ends up in the report.
 */
export async function ensureHqplayer(opts: EnsureOptions, deps: EnsureDeps): Promise<EnsureResult> {
  const report: HqpRunReport = {
    id: nextReportId++,
    at: deps.now(),
    trigger: opts.trigger,
    launchRequested: opts.launchIfStopped,
    windowMode: opts.windowMode,
    exe: { status: 'not-found', source: null, path: null, searched: [] },
    process: { status: 'not-running', image: null },
    window: { status: 'skipped', changed: 0, windows: [] },
  };
  const finish = (): EnsureResult => {
    deps.onReport?.(report);
    return { report, settled: Promise.resolve(report) };
  };

  // 1. the executable
  let exe: HqpExeResolution;
  try {
    exe = await deps.resolveExe();
  } catch (err) {
    exe = {
      exePath: null,
      source: null,
      searched: [{ where: 'registry', result: 'error', detail: shortError(err) }],
    };
  }
  report.exe = {
    status: exe.exePath ? 'found' : 'not-found',
    source: exe.source,
    path: exe.exePath,
    searched: exe.searched,
  };

  // 2. is it running? (process list; the control port only if that list cannot be read)
  let running: HqpProcess | null = null;
  let listed = true;
  try {
    running = findHqplayerProcess(await deps.listProcesses(), exe.exePath);
  } catch (err) {
    listed = false;
    report.process.checkError = shortError(err);
  }
  let image = running?.image ?? (exe.exePath ? basename(exe.exePath) : null);
  let isRunning = running !== null;
  if (!listed) isRunning = await deps.probeEngine().catch(() => false);
  report.process.image = image;

  // 3. start it
  let launched = false;
  if (isRunning) {
    report.process.status = 'running';
  } else if (!opts.launchIfStopped) {
    report.process.status = 'not-running';
    return finish();
  } else if (!exe.exePath) {
    report.process.status = 'no-exe';
    return finish();
  } else {
    let result: HqpLaunchResult;
    try {
      result = await deps.launch(exe.exePath, { hidden: opts.windowMode === 'hidden' });
    } catch (err) {
      result = { ok: false, method: 'direct', error: shortError(err) };
    }
    report.process.method = result.method;
    if (result.error) report.process.error = result.error;
    if (!result.ok) {
      report.process.status = 'start-failed';
      return finish();
    }
    report.process.status = 'started';
    launched = true;
    image = basename(exe.exePath);
    report.process.image = image;
    // Did it really come up? (purely informative; the window step does not depend on it)
    report.process.seen = null;
    if (listed) {
      for (let i = 0; i < 10 && report.process.seen !== true; i += 1) {
        await deps.sleep(500);
        try {
          const now = findHqplayerProcess(await deps.listProcesses(), exe.exePath);
          report.process.seen = now !== null;
          if (now) report.process.image = image = now.image;
        } catch {
          report.process.seen = null;
          break;
        }
      }
    }
  }

  // 4. its windows — a failure here is reported and changes nothing above
  if (opts.windowMode === 'normal') return finish();
  if (!image) {
    report.window = { status: 'failed', changed: 0, windows: [], error: 'process name unknown' };
    return finish();
  }
  const timing = { ...(launched ? WATCH_AFTER_START : WATCH_RUNNING), ...opts.watch };
  report.window = { status: 'watching', changed: 0, windows: [] };
  deps.onReport?.(report);
  const settled = watchWindows(
    {
      processName: processNameOf(image),
      mode: opts.windowMode,
      ...timing,
      expectStart: launched,
      ...(opts.cancel ? { cancel: opts.cancel } : {}),
    },
    deps,
  )
    .catch((err): WatchResult => ({
      status: 'failed',
      changed: 0,
      windows: [],
      error: shortError(err),
    }))
    .then((result) => {
      report.window = result;
      deps.onReport?.(report);
      return report;
    });
  return { report, settled };
}

/**
 * Report history, newest first. A report that is already listed is updated in place; repeated
 * "engine connected" runs replace each other; the startup report is never pushed out.
 */
export function rememberReport(
  list: HqpRunReport[],
  report: HqpRunReport,
  max = 6,
): HqpRunReport[] {
  if (list.some((r) => r.id === report.id)) {
    return list.map((r) => (r.id === report.id ? report : r));
  }
  const rest =
    report.trigger === 'connected' && list[0]?.trigger === 'connected' ? list.slice(1) : list;
  const next = [report, ...rest];
  while (next.length > max) {
    const drop = next.findLastIndex((r) => r.trigger !== 'startup');
    next.splice(drop === -1 ? next.length - 1 : drop, 1);
  }
  return next;
}

// ------------------------------------------------------------------ diagnostics

/**
 * The reports as they go into "复制诊断信息": folders are dropped (file names stay), window titles
 * are replaced by their length (a title can be a track name), error texts are scrubbed.
 */
export function reportsForDiagnostics(reports: HqpRunReport[]): unknown[] {
  return reports.map((r) => ({
    at: new Date(r.at).toISOString(),
    trigger: r.trigger,
    launchRequested: r.launchRequested,
    windowMode: r.windowMode,
    exe: {
      status: r.exe.status,
      source: r.exe.source,
      file: r.exe.path ? basename(r.exe.path) : null,
      searched: r.exe.searched.map((s) => ({
        ...s,
        ...(s.detail ? { detail: scrubPaths(s.detail) } : {}),
      })),
    },
    process: {
      ...r.process,
      ...(r.process.error ? { error: scrubPaths(r.process.error) } : {}),
      ...(r.process.checkError ? { checkError: scrubPaths(r.process.checkError) } : {}),
    },
    window: {
      status: r.window.status,
      changed: r.window.changed,
      windows: r.window.windows.map((w) => ({
        className: w.className,
        titleLength: w.title.length,
      })),
      ...(r.window.error ? { error: scrubPaths(r.window.error) } : {}),
      ...(r.window.ms !== undefined ? { ms: r.window.ms } : {}),
    },
  }));
}
