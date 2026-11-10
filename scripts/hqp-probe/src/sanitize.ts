import type { XmlElement } from '@hqps/hqplayer-adapter';

/** Attribute names that can carry personal data, local paths or licence details. */
const ALWAYS_SENSITIVE = new Set([
  'uri',
  'secure_uri',
  'path',
  'cover',
  'booklet',
  'picture',
  'artist',
  'composer',
  'performer',
  'album',
  'albumartist',
  'album_artist',
  'song',
  'genre',
  'track_id',
  'fingerprint',
  'hash',
  'file',
]);

export interface SanitizedElement {
  name: string;
  attributes: Record<string, string>;
  text?: string;
  children?: SanitizedElement[];
  /** Children summarised when there are many (e.g. long playlists). */
  childSummary?: Record<string, number>;
}

/**
 * Describe a value without revealing it. For path-like values the *shape* is kept, because
 * Phase 1 needs to know how HQPlayer encodes local paths (drive letter vs file:// URI, percent
 * encoding of CJK characters, etc.).
 */
export function describeValue(value: string): string {
  const nonAscii = /[^\p{ASCII}]/u.test(value);
  const pct = /%[0-9A-Fa-f]{2}/.test(value);
  let scheme: string | null = null;
  if (/^[A-Za-z]:[\\/]/.test(value)) scheme = 'native-drive';
  else if (/^\\\\/.test(value)) scheme = 'unc';
  else if (/^file:\/\/\//i.test(value)) scheme = 'file-uri';
  else if (/^file:/i.test(value)) scheme = 'file-uri-other';
  else if (/^https?:/i.test(value)) scheme = 'http';
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) scheme = `${value.split(':')[0]?.toLowerCase()}-uri`;
  else if (value.startsWith('/')) scheme = 'posix-path';
  if (scheme) {
    const sep = value.includes('\\') ? '\\' : '/';
    const parts = value.split(sep).filter(Boolean);
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(value)?.[1]?.toLowerCase() ?? null;
    return `[redacted path scheme=${scheme} sep=${sep === '\\' ? 'backslash' : 'slash'} depth=${parts.length} ext=${ext ?? '-'} nonAscii=${nonAscii ? 'yes' : 'no'} pct=${pct ? 'yes' : 'no'} spaces=${/\s/.test(value) ? 'yes' : 'no'} len=${value.length}]`;
  }
  if (value.length > 200 && /^[A-Za-z0-9+/=]+$/.test(value))
    return `[redacted base64 len=${value.length}]`;
  return `[redacted text len=${value.length} nonAscii=${nonAscii ? 'yes' : 'no'}]`;
}

function looksLikeLocalPath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    /^file:/i.test(value) ||
    /^\/(?:Users|home|mnt|Volumes)\//.test(value)
  );
}

export function sanitizeElement(
  el: XmlElement,
  extraSensitive: readonly string[] = [],
  maxChildren = 5,
): SanitizedElement {
  const sensitive = new Set([...ALWAYS_SENSITIVE, ...extraSensitive]);
  const visit = (node: XmlElement, depth: number): SanitizedElement => {
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.attributes)) {
      attributes[k] =
        v === '' ? '' : sensitive.has(k) || looksLikeLocalPath(v) ? describeValue(v) : v;
    }
    const out: SanitizedElement = { name: node.name, attributes };
    const text = node.text.trim();
    if (text) out.text = looksLikeLocalPath(text) ? describeValue(text) : text.slice(0, 500);
    if (node.children.length && depth < 4) {
      out.children = node.children.slice(0, maxChildren).map((c) => visit(c, depth + 1));
      if (node.children.length > maxChildren) {
        const summary: Record<string, number> = {};
        for (const c of node.children) summary[c.name] = (summary[c.name] ?? 0) + 1;
        out.childSummary = summary;
      }
    }
    return out;
  };
  return visit(el, 0);
}
