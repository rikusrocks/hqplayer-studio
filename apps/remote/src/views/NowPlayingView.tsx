import {
  Artwork,
  FormatBadge,
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
import { useState, type MouseEvent } from 'react';

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
  // A tap on the lyrics goes back to the artwork — but not a tap on the calibration buttons
  // under them, a link, or the end of a text selection. Scrolling never produces a click.
  const onLyricsTap = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button, a, input, .hq-lyrics__footer')) return;
    if (globalThis.getSelection?.()?.toString()) return;
    setShowLyrics(false);
  };
  const albumHref = now.libraryTrack?.albumId
    ? buildHref('/browse/album', now.libraryTrack.albumId)
    : null;

  return (
    <div className={`rm-now${showLyrics ? ' rm-now--lyrics' : ''}`}>
      <QueueSyncBanner />
      {/* The stage takes whatever height is left, so the controls below never leave the screen.
          Tapping it switches between artwork and lyrics. */}
      <div className="rm-now__stage">
        {showLyrics ? (
          <div className="rm-now__lyrics" onClick={onLyricsTap}>
            {/* keyboard / screen-reader way back; touch users tap the lyrics */}
            <button
              type="button"
              className="rm-now__back-to-art"
              onClick={() => setShowLyrics(false)}
            >
              {t('lyrics.showArtwork')}
            </button>
            <LyricsPanel />
          </div>
        ) : (
          <button
            type="button"
            className="rm-now__art"
            onClick={() => setShowLyrics(true)}
            aria-label={t('lyrics.showLyrics')}
            title={t('lyrics.showLyrics')}
          >
            <Artwork artworkId={now.artworkId} size="full" alt={now.album ?? ''} />
          </button>
        )}
      </div>
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
