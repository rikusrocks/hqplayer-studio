import { createHash } from 'node:crypto';

/**
 * LAN clients never see absolute paths of this computer (handoff §12.4). Responses and events for
 * the LAN listener pass through `sanitizeForLan`:
 *  - `uri` fields (HQPlayer reports `file://D:\Music\…`) become an opaque, stable id;
 *  - any string containing a Windows drive path, a UNC path, a file: URI or a POSIX home/volume
 *    path has that part replaced (error messages such as "ENOENT … scandir 'D:\Music'").
 */
// Paths may contain spaces, so a match runs to the next quote/bracket/line end: an unquoted path
// in the middle of a sentence takes the rest of the line with it (over-redacting beats leaking).
const PATH_RE =
  /(?:file:\/\/[^'"<>\r\n]*|\b[A-Za-z]:[\\/][^'"<>\r\n]*|\\\\[^\s'"<>\\]+\\[^'"<>\r\n]*|(?<![\w.])\/(?:Users|home|Volumes|mnt|media|private|var|tmp|srv|opt|root)\/[^'"<>\r\n]*)/g;

export const REDACTED_PATH = '‹path›';

export function redactPaths(text: string): string {
  return text.replace(PATH_RE, REDACTED_PATH);
}

export function opaqueUri(uri: string): string {
  return `uri:${createHash('sha256').update(uri).digest('hex').slice(0, 20)}`;
}

/** Deep copy of `value` that is safe to send to a LAN client. */
export function sanitizeForLan<T>(value: T): T {
  return walk(value, null) as T;
}

function walk(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') {
    if (key === 'uri') return opaqueUri(value);
    return redactPaths(value);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, null));
  if (value && typeof value === 'object') {
    // Buffers/streams are never JSON payloads here; plain objects only.
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
    return out;
  }
  return value;
}
