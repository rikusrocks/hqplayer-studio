import {
  Artwork,
  FormatBadge,
  Icon,
  QueueList,
  QueueSyncBanner,
  buildHref,
  formatDuration,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';
import { useState } from 'react';

type Tab = 'now' | 'queue';

export function SidePanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('queue');

  return (
    <aside className="sidepanel" aria-label={t('queue.title')}>
      <div className="sidepanel__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'now'}
          className={`sidepanel__tab${tab === 'now' ? ' is-active' : ''}`}
          onClick={() => setTab('now')}
        >
          {t('nav.nowPlaying')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'queue'}
          className={`sidepanel__tab${tab === 'queue' ? ' is-active' : ''}`}
          onClick={() => setTab('queue')}
        >
          {t('nav.queue')}
        </button>
        <span className="sidepanel__spacer" />
        <button
          type="button"
          className="hq-icon-btn hq-icon-btn--sm"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="sidepanel__body" role="tabpanel">
        {tab === 'now' ? <NowPlayingPanel /> : <QueueList />}
      </div>
    </aside>
  );
}

function NowPlayingPanel() {
  const t = useT();
  const { status } = useStudio();
  const now = useNowPlaying();

  if (!now.hasTrack) {
    return (
      <div className="np-panel">
        <QueueSyncBanner />
        <div className="np-panel__art">
          <Artwork artworkId={null} size="full" />
        </div>
        <p className="hq-muted">{t('player.nothingPlaying')}</p>
      </div>
    );
  }

  const albumHref = now.libraryTrack?.albumId
    ? buildHref('/albums', now.libraryTrack.albumId)
    : null;
  const dsp = status.dsp;
  const rows: Array<[string, string | null]> = [
    [t('settings.dspMode'), dsp?.mode ?? null],
    [t('settings.dspFilter'), dsp?.filter ?? null],
    [t('settings.dspShaper'), dsp?.shaper ?? null],
    [t('settings.dspRate'), status.output?.label ?? null],
  ];

  return (
    <div className="np-panel">
      <QueueSyncBanner />
      <div className="np-panel__art">
        <Artwork artworkId={now.artworkId} size="full" />
      </div>
      <div className="np-panel__meta">
        <h2 className="np-panel__title">{now.title}</h2>
        <div className="np-panel__artist">{now.artist}</div>
        {now.album &&
          (albumHref ? (
            <a className="np-panel__album" href={albumHref}>
              {now.album}
            </a>
          ) : (
            <div className="np-panel__album">{now.album}</div>
          ))}
      </div>
      <FormatBadge inputLabel={now.inputLabel} output={status.output} />
      <dl className="np-panel__dsp">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v ?? '—'}</dd>
          </div>
        ))}
        <div>
          <dt>{t('col.duration')}</dt>
          <dd>{formatDuration(now.durationMs)}</dd>
        </div>
      </dl>
    </div>
  );
}
