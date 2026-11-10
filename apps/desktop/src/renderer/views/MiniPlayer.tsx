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

/**
 * Compact always-on-top player (route #/mini, also usable in a browser tab): cover, title,
 * previous/play/next, progress, pin (always on top), expand. The window itself is draggable.
 * Only a view on Studio — HQPlayer's audio chain is not touched by opening or closing it.
 */
export function MiniPlayer() {
  const t = useT();
  const now = useNowPlaying();
  const shell = getShell();
  const [onTop, setOnTop] = useState(true);

  useEffect(() => {
    document.body.classList.add('is-mini');
    return () => document.body.classList.remove('is-mini');
  }, []);

  useEffect(() => {
    if (!shell) return;
    let alive = true;
    void shell.getAlwaysOnTop().then((v) => {
      if (alive) setOnTop(v);
    });
    return () => {
      alive = false;
    };
  }, [shell]);

  return (
    <div className="mini">
      {/* part of the window's drag area (Electron drag regions receive no clicks) */}
      <div className="mini__art">
        <Artwork artworkId={now.artworkId} />
      </div>
      <div className="mini__body">
        <div className="mini__top">
          <div className="mini__text">
            <div className="mini__title" title={now.title ?? ''}>
              {now.hasTrack ? now.title : t('player.nothingPlaying')}
            </div>
            <div className="mini__artist" title={now.artist ?? ''}>
              {now.hasTrack ? now.artist : ''}
            </div>
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
              <button
                type="button"
                className="hq-icon-btn hq-icon-btn--sm"
                onClick={() => shell.closeMiniPlayer()}
                title={t('player.closeMini')}
                aria-label={t('player.closeMini')}
              >
                <Icon name="close" size={14} />
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
