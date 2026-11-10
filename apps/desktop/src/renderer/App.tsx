import { matchRoute, useHashRoute, useI18n, type HashRoute } from '@hqps/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { getShell } from './shell';
import { PlayerBar } from './layout/PlayerBar';
import { SidePanel } from './layout/SidePanel';
import { Sidebar } from './layout/Sidebar';
import { StatusBar } from './layout/StatusBar';
import { TopBar } from './layout/TopBar';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { AlbumDetailView } from './views/AlbumDetailView';
import { AlbumsView } from './views/AlbumsView';
import { ArtistDetailView } from './views/ArtistDetailView';
import { ArtistsView } from './views/ArtistsView';
import { FoldersView } from './views/FoldersView';
import { HomeView } from './views/HomeView';
import { MiniPlayer } from './views/MiniPlayer';
import { PlaylistDetailView } from './views/PlaylistDetailView';
import { PlaylistsView } from './views/PlaylistsView';
import { SearchView } from './views/SearchView';
import { SettingsView } from './views/SettingsView';
import { TracksView } from './views/TracksView';

const PANEL_KEY = 'hqps.desktop.panel';

function readPanelOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(PANEL_KEY) !== '0';
  } catch {
    return true;
  }
}

type Params = Record<string, string>;
const ROUTES: Array<[pattern: string, render: (p: Params, route: HashRoute) => ReactNode]> = [
  ['/', () => <HomeView />],
  ['/albums', () => <AlbumsView />],
  ['/albums/:id', (p) => <AlbumDetailView key={p.id} albumId={p.id!} />],
  ['/artists', () => <ArtistsView />],
  ['/artists/:id', (p) => <ArtistDetailView key={p.id} artistId={p.id!} />],
  ['/tracks', () => <TracksView />],
  ['/folders', () => <FoldersView />],
  ['/folders/:root', (p) => <FoldersView rootId={p.root} path="" />],
  ['/folders/:root/*', (p) => <FoldersView rootId={p.root} path={p.rest ?? ''} />],
  ['/playlists', () => <PlaylistsView />],
  ['/playlists/:id', (p) => <PlaylistDetailView key={p.id} playlistId={p.id!} />],
  ['/search', (_p, route) => <SearchView query={route.query.q ?? ''} />],
  ['/settings', () => <SettingsView section="general" />],
  ['/settings/:section', (p) => <SettingsView section={p.section!} />],
];

function renderRoute(route: HashRoute): ReactNode {
  for (const [pattern, render] of ROUTES) {
    const params = matchRoute(pattern, route);
    if (params) return render(params, route);
  }
  return <HomeView />;
}

export function App() {
  const route = useHashRoute('/');
  const [panelOpen, setPanelOpen] = useState(readPanelOpen);
  const { locale } = useI18n();
  useKeyboardShortcuts();
  // The tray menu (main process) speaks the UI's language.
  useEffect(() => getShell()?.setLocale(locale), [locale]);

  if (route.segments[0] === 'mini') return <MiniPlayer />;

  const togglePanel = () => {
    setPanelOpen((open) => {
      try {
        globalThis.localStorage?.setItem(PANEL_KEY, open ? '0' : '1');
      } catch {
        // ignore
      }
      return !open;
    });
  };

  return (
    <div className={`app${panelOpen ? ' app--panel' : ''}`}>
      <Sidebar route={route} />
      <main className="app__main">
        <TopBar route={route} panelOpen={panelOpen} onTogglePanel={togglePanel} />
        <div className="app__content" key={route.path}>
          {renderRoute(route)}
        </div>
      </main>
      {panelOpen && <SidePanel onClose={togglePanel} />}
      <PlayerBar panelOpen={panelOpen} onTogglePanel={togglePanel} />
      <StatusBar />
    </div>
  );
}
