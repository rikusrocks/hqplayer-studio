import { describe, expect, it } from 'vitest';
import { artistVariants, cleanTitle, firstArtist, sameTrack, titleVariants } from './match';

describe('cleanTitle', () => {
  it('drops decorations but keeps brackets that belong to the title', () => {
    expect(cleanTitle('Invented Song (Remastered 2009)')).toBe('Invented Song');
    expect(cleanTitle('Invented Song [Live]')).toBe('Invented Song');
    expect(cleanTitle('Invented Song - 2011 Remaster')).toBe('Invented Song');
    expect(cleanTitle('Invented Song feat. Somebody')).toBe('Invented Song');
    expect(cleanTitle('虚构之歌（电影《虚构》主题曲）')).toBe('虚构之歌');
    expect(cleanTitle('虚构之歌 (现场版)')).toBe('虚构之歌');
    expect(cleanTitle('Invented Song (Part 2)')).toBe('Invented Song (Part 2)');
    expect(cleanTitle('虚构之歌 (粤语版)')).toBe('虚构之歌 (粤语版)'); // another language, other words
    expect(cleanTitle('(Live)')).toBe('(Live)'); // never ends up empty
  });
});

describe('artist names', () => {
  it('takes the first credited artist', () => {
    expect(firstArtist('Lin Xia / Chen Mo')).toBe('Lin Xia');
    expect(firstArtist('林夏、陈默')).toBe('林夏');
    expect(firstArtist('Lin Xia feat. Chen Mo')).toBe('Lin Xia');
    expect(firstArtist('Lin Xia')).toBe('Lin Xia');
  });

  it('lists each variant once, as tagged first', () => {
    expect(titleVariants('Song (Live)')).toEqual(['Song (Live)', 'Song']);
    expect(titleVariants('Song')).toEqual(['Song']);
    expect(artistVariants('A & B')).toEqual(['A & B', 'A']);
  });
});

describe('sameTrack', () => {
  const wanted = { trackName: 'Invented Song (Remastered)', artistName: 'Lin Xia / Chen Mo' };
  it('accepts cleaned titles and the first credited artist', () => {
    expect(sameTrack({ trackName: 'invented song', artistName: 'Lin Xia' }, wanted)).toBe(true);
    expect(sameTrack({ trackName: 'Invented Song', artistName: 'Somebody' }, wanted)).toBe(false);
    expect(sameTrack({ trackName: 'Other Song', artistName: 'Lin Xia' }, wanted)).toBe(false);
  });
  it('checks the duration only when both sides know it', () => {
    const q = { ...wanted, durationSec: 200 };
    const c = { trackName: 'Invented Song', artistName: 'Lin Xia' };
    expect(sameTrack({ ...c, durationSec: 202.5 }, q)).toBe(true);
    expect(sameTrack({ ...c, durationSec: 215 }, q)).toBe(false);
    expect(sameTrack({ ...c, durationSec: null }, q)).toBe(true);
  });
});
