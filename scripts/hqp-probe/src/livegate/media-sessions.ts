import { execFile } from 'node:child_process';

/**
 * Windows "media sessions" — what the volume flyout / keyboard media keys talk to
 * (WinRT GlobalSystemMediaTransportControlsSessionManager). The gate uses it to find out whether
 * the Apple Music app publishes the track that is playing (title, artist, album, cover) and
 * whether it obeys pause / play from another program. It is reached through Windows PowerShell,
 * which ships with Windows, so the tool needs no native add-on.
 */
export interface MediaSessionInfo {
  /** Windows app id, e.g. "AppleInc.AppleMusicWin_…!App". */
  app: string;
  /** The session Windows itself considers the current one. */
  current: boolean;
  /** Playing / Paused / Stopped / Closed / Opened / Changing. */
  status: string;
  title: string;
  artist: string;
  album: string;
  /** Cover size in bytes; 0 = none published, -1 = could not be read. */
  thumbnailBytes: number;
  positionSec: number | null;
  endSec: number | null;
  controls: { play: boolean; pause: boolean; next: boolean; previous: boolean };
}

export interface MediaProbe {
  /** False on anything but Windows: the media-session steps are skipped. */
  supported: boolean;
  list(): Promise<MediaSessionInfo[]>;
  /** Ask one app to pause or play. Resolves to what Windows reported (true = accepted). */
  control(app: string, action: 'pause' | 'play'): Promise<boolean>;
}

/** Apple Music for Windows (Store app); iTunes is matched too in case that is what is installed. */
export const isAppleMusicApp = (app: string): boolean => /apple\s*music|itunes/i.test(app);

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
`;

const LIST = String.raw`
$cur = $mgr.GetCurrentSession()
$out = @()
foreach ($s in $mgr.GetSessions()) {
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $s.GetPlaybackInfo()
  $tl = $s.GetTimelineProperties()
  $thumb = 0
  if ($p.Thumbnail) {
    try {
      $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $thumb = [int64]$stream.Size
    } catch { $thumb = -1 }
  }
  $out += [pscustomobject]@{
    app = [string]$s.SourceAppUserModelId
    current = ($null -ne $cur -and $cur.SourceAppUserModelId -eq $s.SourceAppUserModelId)
    status = [string]$info.PlaybackStatus
    title = [string]$p.Title
    artist = [string]$p.Artist
    album = [string]$p.AlbumTitle
    thumbnailBytes = $thumb
    positionSec = $tl.Position.TotalSeconds
    endSec = $tl.EndTime.TotalSeconds
    controls = [pscustomobject]@{
      play = [bool]$info.Controls.IsPlayEnabled
      pause = [bool]$info.Controls.IsPauseEnabled
      next = [bool]$info.Controls.IsNextEnabled
      previous = [bool]$info.Controls.IsPreviousEnabled
    }
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4
`;

const CONTROL = String.raw`
$target = $mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq '__APP__' } | Select-Object -First 1
if (-not $target) { throw 'media session not found' }
$ok = Await ($target.__METHOD__()) ([bool])
ConvertTo-Json -InputObject @{ ok = [bool]$ok } -Compress
`;

function runPowerShell(script: string): Promise<string> {
  // -EncodedCommand takes UTF-16LE base64, which avoids every quoting problem.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message)
            .replace(/\s+/g, ' ')
            .trim();
          reject(new Error(`Windows media query failed: ${detail.slice(0, 300)}`));
        } else resolve(stdout);
      },
    );
  });
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Turn the PowerShell JSON into typed sessions; anything unexpected becomes an empty value. */
export function parseMediaSessions(stdout: string): MediaSessionInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => {
      const c = (typeof r.controls === 'object' && r.controls !== null ? r.controls : {}) as Record<
        string,
        unknown
      >;
      return {
        app: str(r.app),
        current: r.current === true,
        status: str(r.status),
        title: str(r.title),
        artist: str(r.artist),
        album: str(r.album),
        thumbnailBytes: num(r.thumbnailBytes) ?? 0,
        positionSec: num(r.positionSec),
        endSec: num(r.endSec),
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

export function windowsMediaProbe(platform: string = process.platform): MediaProbe {
  return {
    supported: platform === 'win32',
    async list() {
      return parseMediaSessions(await runPowerShell(PRELUDE + LIST));
    },
    async control(app, action) {
      const script =
        PRELUDE +
        CONTROL.replace('__APP__', () => app.replace(/'/g, "''")).replace(
          '__METHOD__',
          action === 'pause' ? 'TryPauseAsync' : 'TryPlayAsync',
        );
      const out = JSON.parse((await runPowerShell(script)).trim()) as { ok?: unknown };
      return out.ok === true;
    },
  };
}
