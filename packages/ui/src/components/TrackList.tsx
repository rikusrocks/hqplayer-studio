import type { QueueSource, Track } from '@hqps/contracts';
import { Fragment } from 'react';
import { formatDuration } from '../format';
import { useNowPlaying } from '../hooks/useNowPlaying';
import { useT } from '../i18n/I18nProvider';
import { Icon } from './Icon';
import { TrackActionsMenu } from './trackActions';

export interface TrackListProps {
  tracks: Track[];
  /** Insert "Disc N" headers when the tracks span several discs. */
  groupByDisc?: boolean;
  showAlbum?: boolean;
  showArtist?: boolean;
  /** `track` shows the tag track number, `index` the list position. */
  numbering?: 'track' | 'index';
  /** Called when the user plays a row (click on title / double click / Enter). */
  onPlay?: (track: Track, index: number) => void;
  source?: QueueSource;
  compact?: boolean;
}

export function TrackList({
  tracks,
  groupByDisc = false,
  showAlbum = false,
  showArtist = true,
  numbering = 'index',
  onPlay,
  source,
  compact = false,
}: TrackListProps) {
  const t = useT();
  const now = useNowPlaying();
  const currentId = now.libraryTrack?.id ?? null;
  const discs = new Set(tracks.map((tr) => tr.discNumber ?? 1));
  const showDiscHeaders = groupByDisc && discs.size > 1;

  return (
    <div
      className={`hq-tracklist${showAlbum ? ' hq-tracklist--album-col' : ''}${compact ? ' hq-tracklist--compact' : ''}`}
      role="table"
    >
      <div className="hq-tracklist__head" role="row">
        <span role="columnheader" className="hq-tracklist__num">
          {t('col.number')}
        </span>
        <span role="columnheader">{t('col.title')}</span>
        {showAlbum && (
          <span role="columnheader" className="hq-tracklist__album">
            {t('col.album')}
          </span>
        )}
        <span role="columnheader" className="hq-tracklist__fmt">
          {t('col.format')}
        </span>
        <span role="columnheader" className="hq-tracklist__dur">
          {t('col.duration')}
        </span>
        <span role="columnheader" className="hq-visually-hidden">
          {t('common.moreActions')}
        </span>
      </div>
      {tracks.map((track, i) => {
        const disc = track.discNumber ?? 1;
        const prevDisc = i > 0 ? (tracks[i - 1]!.discNumber ?? 1) : null;
        const isCurrent = track.id === currentId;
        const num = numbering === 'track' ? (track.trackNumber ?? i + 1) : i + 1;
        return (
          <Fragment key={`${track.id}:${i}`}>
            {showDiscHeaders && disc !== prevDisc && (
              <div className="hq-tracklist__disc" role="row">
                <Icon name="album" size={14} />
                {t('common.disc', { n: disc })}
              </div>
            )}
            <div
              role="row"
              className={`hq-tracklist__row${isCurrent ? ' is-current' : ''}${track.available ? '' : ' is-unavailable'}`}
              onDoubleClick={() => onPlay?.(track, i)}
            >
              <span className="hq-tracklist__num" role="cell">
                {isCurrent ? <Icon name="volume" size={14} className="hq-accent" /> : num}
              </span>
              <span className="hq-tracklist__title" role="cell">
                <button
                  type="button"
                  className="hq-link-btn"
                  onClick={() => onPlay?.(track, i)}
                  disabled={!onPlay}
                  title={t('actions.playFromHere')}
                >
                  {track.title}
                </button>
                {showArtist && <span className="hq-tracklist__artist">{track.artist}</span>}
                {!track.available && (
                  <span className="hq-badge hq-badge--warn" title={t('album.unavailable')}>
                    {t('common.unavailable')}
                  </span>
                )}
              </span>
              {showAlbum && (
                <span className="hq-tracklist__album" role="cell">
                  {track.album}
                </span>
              )}
              <span className="hq-tracklist__fmt" role="cell">
                {track.format.label}
              </span>
              <span className="hq-tracklist__dur" role="cell">
                {formatDuration(track.durationMs)}
              </span>
              <span className="hq-tracklist__actions" role="cell">
                <TrackActionsMenu trackIds={[track.id]} source={source} />
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
