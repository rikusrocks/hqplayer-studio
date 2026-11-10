import { describe, expect, it } from 'vitest';
import { buildHref, matchRoute, parseHash } from './router';

describe('parseHash', () => {
  it('parses path segments and query', () => {
    const r = parseHash('#/albums/al_1?q=foo&sort=year');
    expect(r.segments).toEqual(['albums', 'al_1']);
    expect(r.path).toBe('/albums/al_1');
    expect(r.query).toEqual({ q: 'foo', sort: 'year' });
  });
  it('defaults to root and tolerates missing slash / bad encoding', () => {
    expect(parseHash('').path).toBe('/');
    expect(parseHash('#albums').segments).toEqual(['albums']);
    expect(parseHash('#/a/%E0%A4%A').segments).toEqual(['a', '%E0%A4%A']);
  });
  it('decodes unicode segments', () => {
    const r = parseHash(`#/folders/${encodeURIComponent('夜の終わりに')}`);
    expect(r.segments[1]).toBe('夜の終わりに');
  });
});

describe('matchRoute', () => {
  it('extracts params', () => {
    expect(matchRoute('/albums/:id', parseHash('#/albums/al_9'))).toEqual({ id: 'al_9' });
    expect(matchRoute('/albums/:id', parseHash('#/albums'))).toBeNull();
    expect(matchRoute('/albums', parseHash('#/albums/x'))).toBeNull();
    expect(matchRoute('/', parseHash('#/'))).toEqual({});
  });
  it('supports a trailing wildcard', () => {
    expect(matchRoute('/folders/:root/*', parseHash('#/folders/r1/a/b'))).toEqual({
      root: 'r1',
      rest: 'a/b',
    });
  });
});

describe('buildHref', () => {
  it('encodes segments and drops empty query values', () => {
    expect(buildHref('/albums', 'al 1')).toBe('#/albums/al%201');
    expect(buildHref('/search', { q: '林夏', empty: '' })).toBe(
      `#/search?q=${encodeURIComponent('林夏')}`,
    );
  });
});
