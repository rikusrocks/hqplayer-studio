import { useCallback, useEffect, useState } from 'react';

export interface HashRoute {
  /** Normalised path, always starting with "/", without trailing slash (except root). */
  path: string;
  segments: string[];
  query: Record<string, string>;
}

/** Parse "#/albums/al_1?q=foo" → { path: "/albums/al_1", segments: ["albums","al_1"], query: {q:"foo"} }. */
export function parseHash(hash: string): HashRoute {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const queryPart = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
  const segments = pathPart
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const query: Record<string, string> = {};
  if (queryPart) {
    for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  }
  return { path: `/${segments.map(encodeURIComponent).join('/')}`, segments, query };
}

/**
 * Match "/albums/:id" against a parsed route. Returns decoded params or null.
 * A trailing "*" in the pattern matches any remaining segments (joined with "/") as `rest`.
 */
export function matchRoute(pattern: string, route: HashRoute): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '*') {
      params.rest = route.segments.slice(i).join('/');
      return params;
    }
    const seg = route.segments[i];
    if (seg === undefined) return null;
    if (part.startsWith(':')) params[part.slice(1)] = seg;
    else if (part !== seg) return null;
  }
  return parts.length === route.segments.length ? params : null;
}

/** Build a hash href: buildHref('/albums', 'al 1', { q: 'x' }) → "#/albums/al%201?q=x". */
export function buildHref(
  base: string,
  ...rest: Array<string | Record<string, string | number | undefined | null>>
): string {
  const segs = base.split('/').filter(Boolean);
  let query = '';
  for (const r of rest) {
    if (typeof r === 'string') segs.push(encodeURIComponent(r));
    else {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(r)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) query = `?${s}`;
    }
  }
  return `#/${segs.join('/')}${query}`;
}

export function navigate(href: string, opts: { replace?: boolean } = {}): void {
  const target = href.startsWith('#') ? href : `#${href.startsWith('/') ? href : `/${href}`}`;
  if (opts.replace) {
    const url = new URL(window.location.href);
    url.hash = target;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function useHashRoute(defaultPath = '/'): HashRoute {
  const read = useCallback(
    () => parseHash(window.location.hash || `#${defaultPath}`),
    [defaultPath],
  );
  const [route, setRoute] = useState<HashRoute>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [read]);
  return route;
}
