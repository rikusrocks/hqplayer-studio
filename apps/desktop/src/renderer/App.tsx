import { matchRoute, useHashRoute, useI18n, type HashRoute } from '@hqps/ui';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { getShell } from './shell';
import { PlayerBar } from './layout/PlayerBar';
import { SidePanel } from './layout/SidePanel';
import { Sidebar, useSidebar } from './layout/Sidebar';
import { TopBar } from './layout/TopBar';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { AlbumDetailView } from './views/AlbumDetailView';
import { AlbumsView } from './views/AlbumsView';
import { AppleMusicView } from './views/AppleMusicView';
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
/** Width of the side panel (queue / lyrics); the desktop window grows by this much for it. */
const PANEL_WIDTH = 344;

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
  ['/apple-music', () => <AppleMusicView />],
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
  const sidebar = useSidebar();
  useKeyboardShortcuts();
  // The tray menu (main process) speaks the UI's language.
  useEffect(() => getShell()?.setLocale(locale), [locale]);

  const isMini = route.segments[0] === 'mini';
  // Launched with the panel open: the window was restored without it, so extend it once.
  useEffect(() => {
    if (!isMini && readPanelOpen()) void getShell()?.setSidePanel(true, PANEL_WIDTH);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only at start
  }, []);

  if (isMini) return <MiniPlayer />;

  /**
   * The panel is appended to the window's right edge, never laid over the content: in the
   * desktop app the window itself grows (first, so the content does not jump), in a browser
   * tab or a maximized window the content makes room.
   */
  const togglePanel = () => {
    const next = !panelOpen;
    try {
      globalThis.localStorage?.setItem(PANEL_KEY, next ? '1' : '0');
    } catch {
      // ignore
    }
    const shell = getShell();
    if (!shell) {
      setPanelOpen(next);
    } else if (next) {
      void shell
        .setSidePanel(true, PANEL_WIDTH)
        .catch(() => false)
        .then(() => setPanelOpen(true));
    } else {
      setPanelOpen(false);
      void shell.setSidePanel(false, PANEL_WIDTH);
    }
  };

  return (
    <div
      className={`app${panelOpen ? ' app--panel' : ''}${sidebar.dragging ? ' is-resizing' : ''}`}
      style={
        { '--sidebar-w': `${sidebar.width}px`, '--panel-w': `${PANEL_WIDTH}px` } as CSSProperties
      }
    >
      <Sidebar route={route} state={sidebar} />
      <main className="app__main">
        <TopBar route={route} />
        <div className="app__content" key={route.path}>
          {renderRoute(route)}
        </div>
      </main>
      {panelOpen && <SidePanel onClose={togglePanel} />}
      <PlayerBar panelOpen={panelOpen} onTogglePanel={togglePanel} />
    </div>
  );
}
