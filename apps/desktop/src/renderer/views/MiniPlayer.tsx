import {
  Artwork,
  ConnectionBadge,
  Icon,
  ProgressBar,
  TransportControls,
  useNowPlaying,
  useT,
} from '@hqps/ui';
import { useEffect, useState } from 'react';
import { getShell } from '../shell';

/** Compact always-on-top player (route #/mini, also usable in a browser tab). */
export function MiniPlayer() {
  const t = useT();
  const now = useNowPlaying();
  const shell = getShell();
  const [onTop, setOnTop] = useState(true);

  useEffect(() => {
    document.body.classList.add('is-mini');
    return () => document.body.classList.remove('is-mini');
  }, []);

  return (
    <div className="mini">
      <div className="mini__art">
        <Artwork artworkId={now.artworkId} />
      </div>
      <div className="mini__body">
        <div className="mini__top">
          <div className="mini__text">
            <div className="mini__title" title={now.title ?? ''}>
              {now.hasTrack ? now.title : t('player.nothingPlaying')}
            </div>
            <div className="mini__artist">{now.hasTrack ? now.artist : ''}</div>
          </div>
          <ConnectionBadge compact />
          {shell && (
            <>
              <button
                type="button"
                className={`hq-icon-btn hq-icon-btn--sm${onTop ? ' is-active' : ''}`}
                onClick={async () => setOnTop(await shell.setAlwaysOnTop(!onTop))}
                aria-pressed={onTop}
                title={t('player.alwaysOnTop')}
                aria-label={t('player.alwaysOnTop')}
              >
                <Icon name="pin" size={14} />
              </button>
              <button
                type="button"
                className="hq-icon-btn hq-icon-btn--sm"
                onClick={() => shell.showMainWindow()}
                title={t('player.expand')}
                aria-label={t('player.expand')}
              >
                <Icon name="expand" size={14} />
              </button>
            </>
          )}
        </div>
        <div className="mini__controls">
          <TransportControls size="sm" />
        </div>
        <ProgressBar showTimes={false} className="mini__progress" />
      </div>
    </div>
  );
}
