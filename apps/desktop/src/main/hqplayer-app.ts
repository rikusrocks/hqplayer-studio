/**
 * Starting HQPlayer Desktop from Studio and keeping its window out of the way (Windows only).
 *
 * Studio never changes HQPlayer's installation or settings: it only starts the program the user
 * already has, and shows / minimizes / hides its window with the standard Win32 ShowWindow call
 * (via PowerShell, so no native addon is needed). A hidden HQPlayer keeps running and playing;
 * Studio controls it over its API as usual, and "显示 HQPlayer" brings the window back.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { win32 } from 'node:path';

// HQPlayer is a Windows program: its paths are always Windows paths (also in tests on a Mac).
const { basename, dirname, join } = win32;
import { promisify } from 'node:util';

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
  title: string;
  className: string;
  visible: boolean;
}

export interface HqpAppState {
  supported: boolean;
  prefs: HqpAppPrefs;
  /** The executable Studio would start (preference or auto-detected). */
  exePath: string | null;
  running: boolean;
  windows: HqpWindowInfo[];
}

export function normalizePrefs(value: unknown): HqpAppPrefs {
  const v = (value ?? {}) as Partial<HqpAppPrefs>;
  return {
    exePath: typeof v.exePath === 'string' && v.exePath.trim() ? v.exePath.trim() : null,
    autoStart: v.autoStart === true,
    windowMode: v.windowMode === 'hidden' || v.windowMode === 'minimized' ? v.windowMode : 'normal',
  };
}

// ------------------------------------------------------------------ detection (registry)

/** `reg query … /s` output → one record per key: { '@key': path, Name: value, … }. */
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
    const m = /^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line);
    if (m && current) current[m[1] as string] = m[3] as string;
  }
  return out;
}

const isHqplayerExe = (name: string) =>
  /hqplayer/i.test(name) && /\.exe$/i.test(name) && !/unins|control|studio|client/i.test(name);

/** HQPlayer Desktop's executable from Windows "installed programs" entries. */
export function exeFromUninstallEntries(
  entries: Record<string, string>[],
  listDir: (dir: string) => string[] = (d) => (existsSync(d) ? readdirSync(d) : []),
): string | null {
  const candidates = entries
    .filter(
      (e) => /hqplayer/i.test(e.DisplayName ?? '') && !/embedded|client/i.test(e.DisplayName ?? ''),
    )
    .sort(
      (a, b) =>
        Number(/desktop/i.test(b.DisplayName ?? '')) - Number(/desktop/i.test(a.DisplayName ?? '')),
    );
  for (const e of candidates) {
    const icon = (e.DisplayIcon ?? '').replace(/^"|"?(,\s*-?\d+)?$/g, '').trim();
    if (icon && isHqplayerExe(basename(icon))) return icon;
    const dir = (e.InstallLocation ?? '').replace(/^"|"$/g, '').trim();
    if (dir) {
      const exe = listDir(dir).find(isHqplayerExe);
      if (exe) return join(dir, exe);
    }
  }
  return null;
}

export async function detectHqplayerExe(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const hives = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const hive of hives) {
    try {
      const { stdout } = await execFileP('reg', ['query', hive, '/s', '/f', 'HQPlayer', '/d'], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const found = exeFromUninstallEntries(parseRegQuery(stdout));
      if (found && existsSync(found)) return found;
    } catch {
      // no match in this hive (reg exits with 1)
    }
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    const signalyst = base ? join(base, 'Signalyst') : null;
    if (!signalyst || !existsSync(signalyst)) continue;
    for (const sub of readdirSync(signalyst)) {
      const dir = join(signalyst, sub);
      try {
        const exe = readdirSync(dir).find(isHqplayerExe);
        if (exe) return join(dir, exe);
      } catch {
        // not a folder
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ process + window control

/**
 * Lists / shows / hides / minimizes the top-level windows of a process. Parameters come from
 * environment variables (never interpolated into the script text).
 *   HQPS_PROC   process name without .exe
 *   HQPS_ACTION list | show | hide | minimize
 *   HQPS_SHOW   regex on "class|title" selecting which hidden windows "show" restores
 */
export const WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
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
    if ($title.Length -eq 0) { continue }
    $cls = [HqpsWin]::Cls($h)
    $visible = [HqpsWin]::IsWindowVisible($h)
    switch ($env:HQPS_ACTION) {
      'hide' { if ($visible) { [void][HqpsWin]::ShowWindow($h, 0); $visible = $false } }
      'minimize' { if ($visible) { [void][HqpsWin]::ShowWindow($h, 6) } }
      'show' {
        if ("$cls|$title" -match $env:HQPS_SHOW) {
          [void][HqpsWin]::ShowWindow($h, 9); [void][HqpsWin]::ShowWindow($h, 5)
          [void][HqpsWin]::SetForegroundWindow($h); $visible = $true
        }
      }
    }
    $wins += [pscustomobject]@{ handle = $h.ToInt64(); title = $title; className = $cls; visible = $visible }
  }
}
[pscustomobject]@{ pids = @($pids); windows = @($wins) } | ConvertTo-Json -Compress -Depth 4
`;

export async function windowControl(
  processName: string,
  action: HqpWindowAction,
  showMatch = 'QWindowIcon|HQPlayer',
): Promise<{ pids: number[]; windows: HqpWindowInfo[] }> {
  if (process.platform !== 'win32') return { pids: [], windows: [] };
  const encoded = Buffer.from(WINDOW_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      windowsHide: true,
      timeout: 20_000,
      env: { ...process.env, HQPS_PROC: processName, HQPS_ACTION: action, HQPS_SHOW: showMatch },
    },
  );
  const parsed = JSON.parse(stdout.trim() || '{}') as {
    pids?: number[] | number;
    windows?: HqpWindowInfo[] | HqpWindowInfo;
  };
  const arr = <T>(v: T | T[] | undefined): T[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  return { pids: arr(parsed.pids), windows: arr(parsed.windows) };
}

export const processNameOf = (exePath: string) => basename(exePath).replace(/\.exe$/i, '');

/** Start HQPlayer (detached: it keeps running when Studio quits). */
export function launchHqplayer(exePath: string): void {
  const child = spawn(exePath, [], {
    cwd: dirname(exePath),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => undefined);
  child.unref();
}

/** Wait until the process shows a titled window, then apply the window mode. */
export async function applyWindowMode(
  exePath: string,
  mode: HqpWindowMode,
  waitMs = 20_000,
): Promise<boolean> {
  if (mode === 'normal') return true;
  const name = processNameOf(exePath);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const { windows } = await windowControl(name, 'list');
    if (windows.some((w) => w.visible)) {
      await windowControl(name, mode === 'hidden' ? 'hide' : 'minimize');
      return true;
    }
    if (windows.length > 0 && mode === 'hidden') return true; // already hidden
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
