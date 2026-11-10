import {
  Artwork,
  FormatBadge,
  Icon,
  LyricsPanel,
  ProgressBar,
  QueueSyncBanner,
  TransportControls,
  VolumeControl,
  buildHref,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';
import { useState } from 'react';

const LYRICS_KEY = 'hqps.remote.showLyrics';

function readShowLyrics(): boolean {
  try {
    return globalThis.localStorage?.getItem(LYRICS_KEY) === '1';
  } catch {
    return false;
  }
}

export function NowPlayingView() {
  const t = useT();
  const { status } = useStudio();
  const now = useNowPlaying();
  const [showLyrics, setShowLyricsState] = useState(readShowLyrics);
  const setShowLyrics = (on: boolean) => {
    setShowLyricsState(on);
    try {
      globalThis.localStorage?.setItem(LYRICS_KEY, on ? '1' : '0');
    } catch {
      // private mode: not remembered
    }
  };
  const albumHref = now.libraryTrack?.albumId
    ? buildHref('/browse/album', now.libraryTrack.albumId)
    : null;

  return (
    <div className="rm-now">
      <QueueSyncBanner />
      {showLyrics ? (
        <div className="rm-now__lyrics">
          <LyricsPanel />
        </div>
      ) : (
        <div className="rm-now__art">
          <Artwork artworkId={now.artworkId} size="full" alt={now.album ?? ''} />
        </div>
      )}
      <button
        type="button"
        className={`rm-now__toggle${showLyrics ? ' is-active' : ''}`}
        onClick={() => setShowLyrics(!showLyrics)}
        aria-pressed={showLyrics}
      >
        <Icon name={showLyrics ? 'album' : 'lyrics'} size={16} />
        {showLyrics ? t('lyrics.showArtwork') : t('lyrics.showLyrics')}
      </button>
      <div className="rm-now__meta">
        <h1 className="rm-now__title">{now.hasTrack ? now.title : t('player.nothingPlaying')}</h1>
        {now.hasTrack && <div className="rm-now__artist">{now.artist}</div>}
        {now.hasTrack &&
          now.album &&
          (albumHref ? (
            <a className="rm-now__album" href={albumHref}>
              {now.album}
            </a>
          ) : (
            <div className="rm-now__album">{now.album}</div>
          ))}
        {now.hasTrack && <FormatBadge inputLabel={now.inputLabel} output={status.output} />}
      </div>
      <ProgressBar className="rm-now__progress" />
      <TransportControls size="lg" />
      <VolumeControl className="rm-now__volume" />
    </div>
  );
}
