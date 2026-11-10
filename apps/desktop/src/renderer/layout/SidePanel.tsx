import {
  Artwork,
  FormatBadge,
  Icon,
  LyricsPanel,
  QueueList,
  QueueSyncBanner,
  buildHref,
  formatDuration,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';
import { useState } from 'react';

type Tab = 'now' | 'lyrics' | 'queue';
const TABS: Tab[] = ['now', 'lyrics', 'queue'];
const TAB_KEY = 'hqps.desktop.panelTab';

function readTab(): Tab {
  try {
    const v = globalThis.localStorage?.getItem(TAB_KEY);
    return TABS.includes(v as Tab) ? (v as Tab) : 'queue';
  } catch {
    return 'queue';
  }
}

const TAB_LABEL = { now: 'nav.nowPlaying', lyrics: 'nav.lyrics', queue: 'nav.queue' } as const;

export function SidePanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      globalThis.localStorage?.setItem(TAB_KEY, next);
    } catch {
      // ignore
    }
  };

  return (
    <aside className="sidepanel" aria-label={t('queue.title')}>
      <div className="sidepanel__tabs" role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`sidepanel__tab${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
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
      <div
        className={`sidepanel__body${tab === 'lyrics' ? ' sidepanel__body--lyrics' : ''}`}
        role="tabpanel"
      >
        {tab === 'now' && <NowPlayingPanel />}
        {tab === 'lyrics' && <LyricsPanel manage settingsHref="#/settings/lyrics" />}
        {tab === 'queue' && <QueueList />}
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
