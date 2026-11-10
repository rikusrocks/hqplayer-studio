import {
  Artwork,
  FormatBadge,
  Icon,
  ProgressBar,
  TransportControls,
  VolumeControl,
  buildHref,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';
import { getShell } from '../shell';

export function PlayerBar({
  panelOpen,
  onTogglePanel,
}: {
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const t = useT();
  const { status } = useStudio();
  const now = useNowPlaying();
  const shell = getShell();
  const albumHref = now.libraryTrack?.albumId
    ? buildHref('/albums', now.libraryTrack.albumId)
    : null;

  return (
    <footer className="playerbar">
      <div className="playerbar__now">
        {albumHref ? (
          <a href={albumHref} className="playerbar__art" aria-label={now.album ?? ''}>
            <Artwork artworkId={now.artworkId} />
          </a>
        ) : (
          <div className="playerbar__art">
            <Artwork artworkId={now.artworkId} />
          </div>
        )}
        <div className="playerbar__text">
          {now.hasTrack ? (
            <>
              <div className="playerbar__title" title={now.title ?? ''}>
                {now.title ?? t('common.unknown')}
              </div>
              <div className="playerbar__artist" title={now.artist ?? ''}>
                {now.artist ?? ''}
              </div>
            </>
          ) : (
            <div className="playerbar__idle">{t('player.nothingPlaying')}</div>
          )}
        </div>
      </div>

      <div className="playerbar__center">
        <TransportControls size="md" />
        <ProgressBar />
      </div>

      <div className="playerbar__right">
        <FormatBadge inputLabel={now.inputLabel} output={now.hasTrack ? status.output : null} />
        <VolumeControl />
        {shell && (
          <button
            type="button"
            className="hq-icon-btn"
            onClick={() => shell.toggleMiniPlayer()}
            title={t('player.miniPlayer')}
            aria-label={t('player.miniPlayer')}
          >
            <Icon name="mini" size={18} />
          </button>
        )}
        <button
          type="button"
          className={`hq-icon-btn${panelOpen ? ' is-active' : ''}`}
          onClick={onTogglePanel}
          aria-pressed={panelOpen}
          title={t('queue.title')}
          aria-label={t('queue.title')}
        >
          <Icon name="queue" size={18} />
        </button>
      </div>
    </footer>
  );
}
