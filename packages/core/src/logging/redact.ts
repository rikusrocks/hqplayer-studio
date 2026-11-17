import { hostname, userInfo } from 'node:os';
import { ProtocolLog } from '@hqps/hqplayer-adapter';

/**
 * Privacy filter for everything written to Studio's log and crash files (handoff §12.7).
 *
 * The log calls themselves never pass titles, artists or paths; this is the second line of
 * defence for text Studio does not control (error messages from HQPlayer, the file system, Node
 * or Electron, stack traces):
 *  - HQPlayer XML attributes that carry paths / metadata → stable labels (`uri#3.flac`), the same
 *    rule as "复制诊断信息" (`ProtocolLog.sanitize`);
 *  - Studio's own install / code folder → `<app>` (stack traces stay useful:
 *    `<app>/dist/main/main.mjs:120:7`);
 *  - any other path (drive, UNC, `file:`, home folders) → `<path>`;
 *  - audio / image / lyrics file names → `<file.flac>`;
 *  - this computer's name and the Windows user name → `<host>` / `<user>`;
 *  - private LAN addresses → `<lan-ip>`; bearer tokens → `<token>`.
 */
export type Redactor = (text: string) => string;

export interface RedactorOptions {
  /** Studio's own code folders (Electron app path, repo root in development). */
  appRoots?: string[];
  /** Defaults to this computer's host name / user name. */
  hostname?: string | null;
  username?: string | null;
}

const MEDIA_EXT =
  'flac|wav|wave|aif|aiff|aifc|dsf|dff|dsd|mp3|m4a|mp4|aac|alac|ape|wv|ogg|oga|opus|wma|lrc|cue|m3u|m3u8|pls|jpg|jpeg|png|webp|gif|bmp';

const PATH_PATTERNS: RegExp[] = [
  // file: URIs, including HQPlayer's "file:" + raw Windows path (may contain spaces)
  /file:[^\n"'<>]*/gi,
  // drive paths C:\… or C:/…
  /\b[A-Za-z]:[\\/][^\n"'<>|]*/g,
  // UNC \\server\share…
  /\\\\[^\s\\"'<>|]+\\[^\n"'<>|]*/g,
  // home and volume folders on macOS / Linux (development machines)
  /(?<![\w<>.-])\/(?:Users|home|Volumes|mnt|media|private|var|tmp|opt|root|srv|data)\/[^\n"'<>|]*/g,
  /(?<![\w])~\/[^\n"'<>|]*/g,
];

/** os.userInfo() throws for some service accounts; a missing name is simply not replaced. */
function safely(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every spelling of a folder that may appear in text: C:\x\y, C:/x/y, file:///C:/x/y. */
function rootPatterns(root: string): RegExp[] {
  const trimmed = root.replace(/[\\/]+$/, '');
  if (trimmed.length < 4) return [];
  const forward = trimmed.replace(/\\/g, '/');
  const variants = new Set([
    trimmed,
    forward,
    `file://${forward.startsWith('/') ? '' : '/'}${forward}`,
  ]);
  return [...variants]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escapeRe(v), 'gi'));
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const protocol = new ProtocolLog();
  const roots = (options.appRoots ?? []).flatMap(rootPatterns);
  const host = safely(() => (options.hostname === undefined ? hostname() : options.hostname));
  const user = safely(() =>
    options.username === undefined ? userInfo().username : options.username,
  );
  const names: Array<[RegExp, string]> = [];
  // short names ("pc", "me") would replace ordinary words: only names of 3+ characters
  const hostShort = host?.replace(/\.(local|lan|home)$/i, '') ?? '';
  if (hostShort.length >= 3) names.push([new RegExp(escapeRe(hostShort), 'gi'), '<host>']);
  if (user && user.length >= 3) {
    names.push([new RegExp(`(?<![\\w])${escapeRe(user)}(?![\\w])`, 'gi'), '<user>']);
  }
  const media = new RegExp(`[^\\s"'<>/\\\\|:*?]+\\.(${MEDIA_EXT})\\b`, 'gi');

  return (input: string): string => {
    if (!input) return input;
    let text = input;
    // 1. HQPlayer XML attributes (uri/title/artist/… → labels)
    if (text.includes('="')) {
      text = text.replace(/\b([A-Za-z_]+)="([^"]*)"/g, (whole) => protocol.sanitize(whole));
    }
    // 2. Studio's own folders keep the part inside the app; every other path is dropped
    for (const re of roots) text = text.replace(re, '<app>');
    for (const re of PATH_PATTERNS) text = text.replace(re, '<path>');
    // 3. file names of music, lyrics, cover art, playlists
    text = text.replace(media, (_m, ext: string) => `<file.${ext.toLowerCase()}>`);
    // 4. this computer and its user
    for (const [re, label] of names) text = text.replace(re, label);
    // 5. LAN addresses and credentials
    text = text.replace(
      /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
      '<lan-ip>',
    );
    text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <token>');
    text = text.replace(/hqps\.auth\.[A-Za-z0-9._~+/=-]+/g, 'hqps.auth.<token>');
    return text;
  };
}
