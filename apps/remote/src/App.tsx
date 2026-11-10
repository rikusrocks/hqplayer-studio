import {
  ConnectionBadge,
  Icon,
  MockBadge,
  matchRoute,
  useHashRoute,
  useStudio,
  useT,
  type HashRoute,
  type IconName,
  type MessageKey,
} from '@hqps/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NowStrip } from './NowStrip';
import { SettingsSheet } from './SettingsSheet';
import { AlbumView } from './views/AlbumView';
import { BrowseView } from './views/BrowseView';
import { NowPlayingView } from './views/NowPlayingView';
import { PlaylistView } from './views/PlaylistView';
import { PlaylistsView } from './views/PlaylistsView';
import { QueueView } from './views/QueueView';

type Tab = 'now' | 'browse' | 'playlists' | 'queue';

const TABS: Array<{ id: Tab; icon: IconName; label: MessageKey }> = [
  { id: 'now', icon: 'play', label: 'nav.nowPlaying' },
  { id: 'browse', icon: 'album', label: 'nav.browse' },
  { id: 'playlists', icon: 'playlist', label: 'nav.playlists' },
  { id: 'queue', icon: 'queue', label: 'nav.queue' },
];

type Params = Record<string, string>;
const ROUTES: Array<[pattern: string, render: (p: Params, route: HashRoute) => ReactNode]> = [
  ['/now', () => <NowPlayingView />],
  ['/browse', (_p, route) => <BrowseView initialQuery={route.query.q ?? ''} />],
  ['/browse/album/:id', (p) => <AlbumView key={p.id} albumId={p.id!} />],
  ['/playlists', () => <PlaylistsView />],
  ['/playlists/:id', (p) => <PlaylistView key={p.id} playlistId={p.id!} />],
  ['/queue', () => <QueueView />],
];

function renderRoute(route: HashRoute): ReactNode {
  for (const [pattern, render] of ROUTES) {
    const params = matchRoute(pattern, route);
    if (params) return render(params, route);
  }
  return <NowPlayingView />;
}

export function App() {
  const t = useT();
  const route = useHashRoute('/now');
  const { serverReachable } = useStudio();
  const [sheetOpen, setSheetOpen] = useState(false);
  const tab: Tab = (TABS.find((x) => x.id === route.segments[0])?.id ?? 'now') as Tab;
  const contentRef = useRef<HTMLElement>(null);

  // Scroll to top on navigation (mobile expectation).
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [route.path]);

  return (
    <div className="rm">
      <header className="rm-header">
        <div className="rm-header__title">
          <span className="rm-logo" aria-hidden="true">
            <Icon name="wave" size={16} />
          </span>
          {t('remote.title')}
        </div>
        <div className="rm-header__right">
          <MockBadge />
          <ConnectionBadge compact />
          <button
            type="button"
            className="hq-icon-btn"
            onClick={() => setSheetOpen(true)}
            aria-label={t('remote.settings')}
            title={t('remote.settings')}
          >
            <Icon name="settings" size={20} />
          </button>
        </div>
      </header>

      {!serverReachable && (
        <div className="rm-offline" role="alert">
          <Icon name="warning" size={18} />
          <span>{t('remote.offline')}</span>
        </div>
      )}

      <main className="rm-content" ref={contentRef}>
        {renderRoute(route)}
      </main>

      {tab !== 'now' && <NowStrip />}

      <nav className="rm-tabs" aria-label={t('nav.library')}>
        {TABS.map((x) => (
          <a
            key={x.id}
            href={`#/${x.id}`}
            className={`rm-tab${tab === x.id ? ' is-active' : ''}`}
            aria-current={tab === x.id ? 'page' : undefined}
          >
            <Icon name={x.icon} size={22} />
            <span>{t(x.label)}</span>
          </a>
        ))}
      </nav>

      {sheetOpen && <SettingsSheet onClose={() => setSheetOpen(false)} />}
    </div>
  );
}
