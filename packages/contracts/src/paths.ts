/** Path helpers shared by Core, the library and the Gate C tool (no Node APIs). */

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Convert a path/URI reported by HQPlayer back to a local path.
 *
 * Observed on HQPlayer Desktop 6.1.0 (probes 2026-11-10): uri = "file://" followed by a raw
 * Windows path — backslashes, spaces and non-ASCII characters NOT percent-encoded. Raw forms
 * are therefore never URI-decoded ("100% Pure.flac" must survive). Proper RFC 8089 URIs
 * (`file:///D:/a%20b.flac`, `file://server/share/x.flac`) are decoded.
 */
export function engineUriToPath(uriOrPath: string): string | null {
  const s = uriOrPath.trim();
  if (!s) return null;
  if (!/^file:/i.test(s)) return s;
  const rest = s.slice(5);
  // Windows drive after any number of slashes/backslashes: file:D:\…, file://D:\…, file:///D:/…
  const drive = /^[\\/]*([A-Za-z]:[\\/].*)$/.exec(rest);
  if (drive) {
    const path = drive[1] as string;
    const encoded = !path.includes('\\') && /%[0-9A-Fa-f]{2}/.test(path) && !/\s/.test(path);
    return encoded ? safeDecode(path) : path;
  }
  // UNC written raw: file:\\server\share\…
  if (/^\\\\[^\\]/.test(rest)) return rest;
  // RFC 8089 local absolute path: file:///Users/…
  if (rest.startsWith('///')) return safeDecode(rest.slice(2));
  // RFC 8089 with authority: file://server/share/… → UNC
  if (rest.startsWith('//')) {
    const decoded = safeDecode(rest.slice(2));
    return decoded ? `\\\\${decoded.replace(/\//g, '\\')}` : null;
  }
  return safeDecode(rest);
}

/** Comparison key for Windows-style paths: case-insensitive, NFC, forward slashes. */
export function windowsPathKey(path: string): string {
  return path
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

/** True when an engine URI/path and a local path refer to the same file. */
export function sameEnginePath(engineUriOrPath: string, localPath: string): boolean {
  const p = engineUriToPath(engineUriOrPath);
  return p !== null && windowsPathKey(p) === windowsPathKey(localPath);
}
