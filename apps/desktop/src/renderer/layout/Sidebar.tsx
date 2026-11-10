import {
  Icon,
  buildHref,
  useStudio,
  useT,
  type HashRoute,
  type IconName,
  type MessageKey,
} from '@hqps/ui';

const NAV: Array<{ path: string; icon: IconName; label: MessageKey }> = [
  { path: '/', icon: 'home', label: 'nav.home' },
  { path: '/albums', icon: 'album', label: 'nav.albums' },
  { path: '/artists', icon: 'artist', label: 'nav.artists' },
  { path: '/tracks', icon: 'track', label: 'nav.tracks' },
  { path: '/folders', icon: 'folder', label: 'nav.folders' },
  { path: '/playlists', icon: 'playlist', label: 'nav.playlists' },
];

function isActive(route: HashRoute, path: string): boolean {
  if (path === '/') return route.path === '/';
  return route.path === path || route.path.startsWith(`${path}/`);
}

export function Sidebar({ route }: { route: HashRoute }) {
  const t = useT();
  const { playlists } = useStudio();

  return (
    <nav className="sidebar" aria-label={t('nav.library')}>
      <a className="sidebar__brand" href="#/" title={t('app.disclaimer')}>
        <span className="sidebar__logo" aria-hidden="true">
          <Icon name="wave" size={18} />
        </span>
        <span className="sidebar__brand-text">
          HQPlayer <strong>Studio</strong>
        </span>
      </a>

      <ul className="sidebar__nav">
        {NAV.map((item) => (
          <li key={item.path}>
            <a
              href={`#${item.path}`}
              className={`sidebar__link${isActive(route, item.path) ? ' is-active' : ''}`}
              aria-current={isActive(route, item.path) ? 'page' : undefined}
              title={t(item.label)}
            >
              <Icon name={item.icon} size={18} />
              <span className="sidebar__label">{t(item.label)}</span>
            </a>
          </li>
        ))}
      </ul>

      {playlists.length > 0 && (
        <div className="sidebar__section">
          <div className="sidebar__heading">{t('nav.playlists')}</div>
          <ul className="sidebar__playlists">
            {playlists.map((pl) => {
              const href = buildHref('/playlists', pl.id);
              const active = route.path === href.slice(1);
              return (
                <li key={pl.id}>
                  <a
                    href={href}
                    className={`sidebar__pl${active ? ' is-active' : ''}`}
                    title={pl.name}
                  >
                    {pl.name}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="sidebar__footer">
        <a
          href="#/settings"
          className={`sidebar__link${isActive(route, '/settings') ? ' is-active' : ''}`}
          title={t('nav.settings')}
        >
          <Icon name="settings" size={18} />
          <span className="sidebar__label">{t('nav.settings')}</span>
        </a>
        <p className="sidebar__disclaimer">{t('app.disclaimer')}</p>
      </div>
    </nav>
  );
}
