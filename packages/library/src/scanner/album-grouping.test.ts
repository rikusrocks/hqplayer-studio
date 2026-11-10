import { describe, expect, it } from 'vitest';
import { planFolderAlbum } from './album-grouping';

const t = (
  id: string,
  albumId: string,
  album: string,
  track: number | null,
  disc: number | null = null,
) => ({
  id,
  albumId,
  album,
  track,
  disc,
});

describe('planFolderAlbum', () => {
  it('joins one numbered album whose tags use two languages', () => {
    const plan = planFolderAlbum([
      t('1', 'zh', '城市漫游者', 1),
      t('2', 'zh', '城市漫游者', 2),
      t('3', 'en', 'City Wanderer', 3),
      t('4', 'zh', '城市漫游者', 4),
    ]);
    expect(plan).toEqual({ albumId: 'zh', title: '城市漫游者' });
  });

  it('handles discs and prefers the album holding disc 1 track 1 on a tie', () => {
    expect(
      planFolderAlbum([
        t('1', 'b', 'Live (Bonus)', 1, 2),
        t('2', 'b', 'Live (Bonus)', 2, 2),
        t('3', 'a', 'Live', 1, 1),
        t('4', 'a', 'Live', 2, 1),
      ]),
    ).toEqual({ albumId: 'a', title: 'Live' });
  });

  it('leaves real mixtures alone', () => {
    // two different albums both numbered from 1
    expect(
      planFolderAlbum([
        t('1', 'a', 'A', 1),
        t('2', 'a', 'A', 2),
        t('3', 'b', 'B', 1),
        t('4', 'b', 'B', 2),
      ]),
    ).toBeNull();
    // unnumbered singles
    expect(planFolderAlbum([t('1', 'a', 'A', null), t('2', 'b', 'B', null)])).toBeNull();
    // numbering with big gaps (picked tracks from several albums)
    expect(planFolderAlbum([t('1', 'a', 'A', 3), t('2', 'b', 'B', 9)])).toBeNull();
    // too many different titles
    expect(
      planFolderAlbum([
        t('1', 'a', 'A', 1),
        t('2', 'b', 'B', 2),
        t('3', 'c', 'C', 3),
        t('4', 'd', 'D', 4),
      ]),
    ).toBeNull();
    // already one album
    expect(planFolderAlbum([t('1', 'a', 'A', 1), t('2', 'a', 'A', 2)])).toBeNull();
  });
});
