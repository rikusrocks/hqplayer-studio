import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * What Windows knows about other apps' playback — the "media sessions" behind the volume flyout
 * and the keyboard media keys (WinRT GlobalSystemMediaTransportControlsSessionManager) — plus a
 * few facts about the PC's audio set-up that the Apple Music page checks.
 *
 * Everything goes through Windows PowerShell, which ships with Windows, so Studio needs no
 * native add-on. One long-running PowerShell watches the sessions (a line of JSON whenever
 * something changes); controls, covers and the set-up check are short one-off runs.
 *
 * NOT YET RUN ON WINDOWS: these scripts were written on a Mac. Every failure is reported to the
 * page as text instead of being swallowed, so the first real run tells us what to fix.
 */
export interface MediaSession {
  /** Windows app id, e.g. "AppleInc.AppleMusicWin_…!App". */
  app: string;
  /** Playing / Paused / Stopped / Closed / Opened / Changing. */
  status: string;
  title: string;
  artist: string;
  album: string;
  hasThumbnail: boolean;
  /** Position as of `positionAt` (epoch ms); null when the app publishes no timeline. */
  positionMs: number | null;
  positionAt: number | null;
  durationMs: number | null;
  controls: { play: boolean; pause: boolean; next: boolean; previous: boolean };
}

export type MediaAction = 'play' | 'pause' | 'next' | 'previous';

/** Facts for the set-up check. `null` = that part of the query failed. */
export interface SystemAudioInfo {
  /** Sound devices and audio endpoints by name (playback and recording). */
  devices: string[] | null;
  /** "Allow" / "Deny" for desktop apps using audio inputs; null = could not be read. */
  microphoneAccess: 'allow' | 'deny' | null;
  appleMusic: { installed: boolean; running: boolean; familyName: string | null } | null;
  errors: string[];
}

export type OpenTarget = 'sound' | 'app-volume' | 'microphone' | 'cable-site' | 'apple-music';

export interface WindowsMedia {
  /** False on anything but Windows. */
  readonly supported: boolean;
  /** Demo data (mock engine) — never evidence of a real PC. */
  readonly simulated: boolean;
  /** Start watching. `onChange` gets every session; `onError` gets the failure text or null. */
  watch(
    onChange: (sessions: MediaSession[]) => void,
    onError: (message: string | null) => void,
  ): () => void;
  control(app: string, action: MediaAction): Promise<boolean>;
  artwork(app: string): Promise<{ data: Buffer; mime: string } | null>;
  inspect(): Promise<SystemAudioInfo>;
  /** Open a Windows settings page, the cable maker's site or the Apple Music app. */
  open(target: OpenTarget, familyName?: string | null): Promise<void>;
}

/** Apple Music for Windows (Store app); iTunes is matched too in case that is what is installed. */
export const isAppleMusicApp = (app: string): boolean => /apple\s*music|itunes/i.test(app);

/** Device names that look like a virtual audio cable. */
export const looksLikeVirtualCable = (name: string): boolean =>
  /vb-audio|vb-cable|\bcable\b|hi-?fi cable|virtual audio|voicemeeter|loopback|blackhole/i.test(
    name,
  );

// --- PowerShell ---------------------------------------------------------------------------------

const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -match '^IAsyncOperation.1$'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(8000)) { throw 'timed out waiting for Windows' }
  $task.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Read-Sessions {
  $out = @()
  foreach ($s in $mgr.GetSessions()) {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $end = $tl.EndTime.TotalMilliseconds
    $out += [pscustomobject]@{
      app = [string]$s.SourceAppUserModelId
      status = [string]$info.PlaybackStatus
      title = [string]$p.Title
      artist = [string]$p.Artist
      album = [string]$p.AlbumTitle
      hasThumbnail = ($null -ne $p.Thumbnail)
      positionMs = if ($end -gt 0) { [math]::Round($tl.Position.TotalMilliseconds) } else { $null }
      positionAt = if ($end -gt 0) { $tl.LastUpdatedTime.ToUnixTimeMilliseconds() } else { $null }
      durationMs = if ($end -gt 0) { [math]::Round($end) } else { $null }
      controls = [pscustomobject]@{
        play = [bool]$info.Controls.IsPlayEnabled
        pause = [bool]$info.Controls.IsPauseEnabled
        next = [bool]$info.Controls.IsNextEnabled
        previous = [bool]$info.Controls.IsPreviousEnabled
      }
    }
  }
  ConvertTo-Json -InputObject @($out) -Compress -Depth 4
}
`;

/** Prints one JSON line whenever the sessions change (and a heartbeat every 15 s). */
const WATCH = String.raw`
$last = ''
$beat = 0
while ($true) {
  try {
    $json = Read-Sessions
    $beat += 1
    if ($json -ne $last -or $beat -ge 15) {
      $last = $json
      $beat = 0
      [Console]::Out.WriteLine('{"sessions":' + $json + '}')
      [Console]::Out.Flush()
    }
  } catch {
    $msg = ([string]$_.Exception.Message) -replace '["\\\r\n]', ' '
    [Console]::Out.WriteLine('{"error":"' + $msg + '"}')
    [Console]::Out.Flush()
    Start-Sleep -Seconds 4
  }
  Start-Sleep -Milliseconds 1000
}
`;

const FIND = String.raw`
$target = $mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq '__APP__' } | Select-Object -First 1
if (-not $target) { throw 'media session not found' }
`;

const CONTROL =
  FIND +
  String.raw`
$ok = Await ($target.__METHOD__()) ([bool])
ConvertTo-Json -InputObject @{ ok = [bool]$ok } -Compress
`;

const ARTWORK =
  FIND +
  String.raw`
$p = Await ($target.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
if (-not $p.Thumbnail) { '{"data":null}'; return }
$stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
try { $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream) }
catch { $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0)) }
$ms = New-Object System.IO.MemoryStream
$net.CopyTo($ms)
ConvertTo-Json -InputObject @{ mime = [string]$stream.ContentType; data = [Convert]::ToBase64String($ms.ToArray()) } -Compress
`;

/** Needs none of the WinRT prelude: plain device, registry and package queries. */
const INSPECT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$errors = @()
$devices = $null
try {
  $names = @()
  $names += @(Get-CimInstance Win32_SoundDevice | ForEach-Object { [string]$_.Name })
  try { $names += @(Get-PnpDevice -Class AudioEndpoint -PresentOnly | ForEach-Object { [string]$_.FriendlyName }) }
  catch { $errors += 'endpoints: ' + [string]$_.Exception.Message }
  $devices = @($names | Where-Object { $_ } | Sort-Object -Unique)
} catch { $errors += 'devices: ' + [string]$_.Exception.Message }
$mic = $null
try {
  $base = 'Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
  $values = @()
  foreach ($path in @("HKLM:\$base", "HKCU:\$base", "HKCU:\$base\NonPackaged")) {
    $item = Get-ItemProperty -Path $path -Name Value -ErrorAction SilentlyContinue
    if ($item) { $values += [string]$item.Value }
  }
  if ($values.Count -gt 0) { $mic = if ($values -contains 'Deny') { 'deny' } else { 'allow' } }
} catch { $errors += 'microphone: ' + [string]$_.Exception.Message }
$apple = $null
try {
  $pkg = Get-AppxPackage -Name '*AppleMusic*' | Select-Object -First 1
  $running = @(Get-Process -Name 'AppleMusic' -ErrorAction SilentlyContinue).Count -gt 0
  $apple = [pscustomobject]@{
    installed = ($null -ne $pkg)
    running = [bool]$running
    familyName = if ($pkg) { [string]$pkg.PackageFamilyName } else { $null }
  }
} catch { $errors += 'apple music: ' + [string]$_.Exception.Message }
ConvertTo-Json -InputObject ([pscustomobject]@{ devices = $devices; microphoneAccess = $mic; appleMusic = $apple; errors = @($errors) }) -Compress -Depth 4
`;

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
// -EncodedCommand takes UTF-16LE base64, which avoids every quoting problem.
const encode = (script: string) => Buffer.from(script, 'utf16le').toString('base64');
const quote = (value: string) => value.replace(/'/g, "''");

function runPowerShell(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [...POWERSHELL_ARGS, '-EncodedCommand', encode(script)],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(cleanError(String(stderr || err.message))));
        else resolve(stdout);
      },
    );
  });
}

/** PowerShell errors arrive as CLIXML or long traces: keep one readable line. */
export function cleanError(text: string): string {
  const flat = text
    .replace(/#< CLIXML/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/_x000D__x000A_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (flat || 'Windows PowerShell failed').slice(0, 300);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** Turn the PowerShell JSON into typed sessions; anything unexpected becomes an empty value. */
export function parseSessions(value: unknown): MediaSession[] {
  const rows = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return rows
    .map(obj)
    .map((r) => {
      const c = obj(r.controls);
      const duration = num(r.durationMs);
      return {
        app: str(r.app),
        status: str(r.status),
        title: str(r.title),
        artist: str(r.artist),
        album: str(r.album),
        hasThumbnail: r.hasThumbnail === true,
        positionMs: duration !== null && duration > 0 ? Math.max(0, num(r.positionMs) ?? 0) : null,
        positionAt: duration !== null && duration > 0 ? num(r.positionAt) : null,
        durationMs: duration !== null && duration > 0 ? duration : null,
        controls: {
          play: c.play === true,
          pause: c.pause === true,
          next: c.next === true,
          previous: c.previous === true,
        },
      };
    })
    .filter((s) => s.app !== '');
}

/** One line from the watcher: sessions, or the error it hit. */
export function parseWatchLine(
  line: string,
): { sessions: MediaSession[] } | { error: string } | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = obj(JSON.parse(text));
    if (typeof parsed.error === 'string') return { error: parsed.error.slice(0, 300) };
    if ('sessions' in parsed) return { sessions: parseSessions(parsed.sessions) };
  } catch {
    // a torn or foreign line: ignore it
  }
  return null;
}

export function parseInspect(stdout: string): SystemAudioInfo {
  const r = obj(JSON.parse(stdout.trim()));
  const apple = r.appleMusic === null || r.appleMusic === undefined ? null : obj(r.appleMusic);
  const mic = str(r.microphoneAccess).toLowerCase();
  return {
    devices: Array.isArray(r.devices) ? r.devices.map(str).filter(Boolean) : null,
    microphoneAccess: mic === 'allow' || mic === 'deny' ? mic : null,
    appleMusic: apple
      ? {
          installed: apple.installed === true,
          running: apple.running === true,
          familyName: str(apple.familyName) || null,
        }
      : null,
    errors: Array.isArray(r.errors) ? r.errors.map(str).filter(Boolean) : [],
  };
}

/** PNG / JPEG / GIF / WebP / BMP by their first bytes (Windows often sends no content type). */
export function sniffImageMime(data: Buffer, declared = ''): string | null {
  if (data.length < 12) return null;
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return /^image\/(png|jpeg|gif|webp|bmp)$/.test(declared) ? declared : null;
}

const OPEN_URIS: Record<Exclude<OpenTarget, 'apple-music'>, string> = {
  sound: 'ms-settings:sound',
  'app-volume': 'ms-settings:apps-volume',
  microphone: 'ms-settings:privacy-microphone',
  'cable-site': 'https://vb-audio.com/Cable/',
};

const METHODS: Record<MediaAction, string> = {
  play: 'TryPlayAsync',
  pause: 'TryPauseAsync',
  next: 'TrySkipNextAsync',
  previous: 'TrySkipPreviousAsync',
};

class PowerShellMedia implements WindowsMedia {
  readonly supported = true;
  readonly simulated = false;

  watch(
    onChange: (sessions: MediaSession[]) => void,
    onError: (message: string | null) => void,
  ): () => void {
    let stopped = false;
    let child: ChildProcess | null = null;
    let restarts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const start = () => {
      if (stopped) return;
      let stderr = '';
      const proc = spawn(
        'powershell.exe',
        [...POWERSHELL_ARGS, '-EncodedCommand', encode(PRELUDE + WATCH)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child = proc;
      proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      if (proc.stdout) {
        createInterface({ input: proc.stdout.setEncoding('utf8') }).on('line', (line) => {
          const parsed = parseWatchLine(line);
          if (!parsed) return;
          if ('error' in parsed) onError(parsed.error);
          else {
            restarts = 0;
            onError(null);
            onChange(parsed.sessions);
          }
        });
      }
      const ended = (reason: string) => {
        if (child !== proc) return;
        child = null;
        if (stopped) return;
        onError(cleanError(stderr || reason));
        restarts += 1;
        // Back off; after a few failures in a row keep trying once a minute (cheap, and the
        // page keeps showing the reason).
        timer = setTimeout(start, restarts > 4 ? 60_000 : 2000 * restarts);
      };
      proc.on('error', (err) => ended(err.message));
      proc.on('exit', (code) => ended(`the Windows media watcher stopped (exit ${code ?? '?'})`));
    };
    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill();
      child = null;
    };
  }

  async control(app: string, action: MediaAction): Promise<boolean> {
    const script =
      PRELUDE + CONTROL.replace('__APP__', () => quote(app)).replace('__METHOD__', METHODS[action]);
    return obj(JSON.parse((await runPowerShell(script)).trim())).ok === true;
  }

  async artwork(app: string): Promise<{ data: Buffer; mime: string } | null> {
    const out = obj(
      JSON.parse(
        (await runPowerShell(PRELUDE + ARTWORK.replace('__APP__', () => quote(app)))).trim(),
      ),
    );
    if (typeof out.data !== 'string' || out.data === '') return null;
    const data = Buffer.from(out.data, 'base64');
    const mime = sniffImageMime(data, str(out.mime));
    return mime ? { data, mime } : null;
  }

  async inspect(): Promise<SystemAudioInfo> {
    return parseInspect(await runPowerShell(INSPECT));
  }

  open(target: OpenTarget, familyName?: string | null): Promise<void> {
    const uri =
      target === 'apple-music'
        ? `shell:AppsFolder\\${familyName ?? 'AppleInc.AppleMusicWin_nzyj5cx40ttqa'}!App`
        : OPEN_URIS[target];
    return new Promise((resolve, reject) => {
      // explorer.exe hands the URI to Windows (settings page, default browser or Store app);
      // it exits with code 1 even on success, so only a failure to start counts.
      const proc = spawn('explorer.exe', [uri], { windowsHide: true, stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('spawn', () => resolve());
    });
  }
}

class UnsupportedMedia implements WindowsMedia {
  readonly supported = false;
  readonly simulated = false;
  watch(): () => void {
    return () => undefined;
  }
  async control(): Promise<boolean> {
    return false;
  }
  async artwork(): Promise<null> {
    return null;
  }
  async inspect(): Promise<SystemAudioInfo> {
    return { devices: null, microphoneAccess: null, appleMusic: null, errors: [] };
  }
  async open(): Promise<void> {
    throw new Error('Only available on Windows');
  }
}

export function windowsMedia(platform: string = process.platform): WindowsMedia {
  return platform === 'win32' ? new PowerShellMedia() : new UnsupportedMedia();
}

// --- demo ---------------------------------------------------------------------------------------

const DEMO_APP = 'AppleInc.AppleMusicWin_demo!App';
const DEMO_TRACKS = [
  { title: 'Paper Lanterns', artist: 'The Demo Quartet', album: 'Night Market', ms: 214_000 },
  { title: 'Slow Tide', artist: 'The Demo Quartet', album: 'Night Market', ms: 187_000 },
  { title: 'Glass Stairs', artist: 'Mock & Co.', album: 'Rooms', ms: 251_000 },
];

/**
 * A pretend Apple Music for the mock engine, so the page can be explored on any computer.
 * Clearly fictional titles; flagged `simulated` all the way to the screen.
 */
export class SimulatedMedia implements WindowsMedia {
  readonly supported = true;
  readonly simulated = true;
  private index = 0;
  private playing = true;
  private positionMs = 0;
  private positionAt = Date.now();
  private listener: ((sessions: MediaSession[]) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private session(): MediaSession {
    const t = DEMO_TRACKS[this.index % DEMO_TRACKS.length] as (typeof DEMO_TRACKS)[number];
    return {
      app: DEMO_APP,
      status: this.playing ? 'Playing' : 'Paused',
      title: t.title,
      artist: t.artist,
      album: t.album,
      hasThumbnail: true,
      positionMs: this.positionMs,
      positionAt: this.positionAt,
      durationMs: t.ms,
      controls: { play: true, pause: true, next: true, previous: true },
    };
  }

  private now(): number {
    return this.playing ? this.positionMs + (Date.now() - this.positionAt) : this.positionMs;
  }

  private emit(): void {
    this.listener?.([this.session()]);
  }

  private move(step: number): void {
    this.index = (this.index + step + DEMO_TRACKS.length) % DEMO_TRACKS.length;
    this.positionMs = 0;
    this.positionAt = Date.now();
  }

  watch(onChange: (sessions: MediaSession[]) => void, onError: (m: string | null) => void) {
    this.listener = onChange;
    onError(null);
    this.emit();
    this.timer = setInterval(() => {
      const t = DEMO_TRACKS[this.index % DEMO_TRACKS.length] as (typeof DEMO_TRACKS)[number];
      if (this.playing && this.now() >= t.ms) {
        this.move(1);
        this.emit();
      }
    }, 1000);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.listener = null;
    };
  }

  async control(_app: string, action: MediaAction): Promise<boolean> {
    if (action === 'play' || action === 'pause') {
      this.positionMs = this.now();
      this.positionAt = Date.now();
      this.playing = action === 'play';
    } else this.move(action === 'next' ? 1 : -1);
    this.emit();
    return true;
  }

  async artwork(): Promise<{ data: Buffer; mime: string }> {
    const hue = (this.index * 97 + 20) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="hsl(${hue} 55% 42%)"/><circle cx="150" cy="150" r="86" fill="hsl(${hue} 60% 62%)"/><circle cx="150" cy="150" r="22" fill="hsl(${hue} 55% 30%)"/></svg>`;
    return { data: Buffer.from(svg, 'utf8'), mime: 'image/svg+xml' };
  }

  async inspect(): Promise<SystemAudioInfo> {
    return {
      devices: ['Simulated Virtual Cable (demo)', 'Simulated DAC (demo)'],
      microphoneAccess: 'allow',
      appleMusic: { installed: true, running: true, familyName: null },
      errors: [],
    };
  }

  async open(): Promise<void> {
    // nothing to open in the demo
  }
}
