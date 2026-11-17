import {
  BrandMark,
  Icon,
  buildHref,
  useStudio,
  useT,
  type HashRoute,
  type IconName,
  type MessageKey,
} from '@hqps/ui';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';

const NAV: Array<{ path: string; icon: IconName; label: MessageKey }> = [
  { path: '/', icon: 'home', label: 'nav.home' },
  { path: '/albums', icon: 'album', label: 'nav.albums' },
  { path: '/artists', icon: 'artist', label: 'nav.artists' },
  { path: '/tracks', icon: 'track', label: 'nav.tracks' },
  { path: '/folders', icon: 'folder', label: 'nav.folders' },
  { path: '/playlists', icon: 'playlist', label: 'nav.playlists' },
];

const COLLAPSED_KEY = 'hqps.desktop.sidebar.collapsed';
const WIDTH_KEY = 'hqps.desktop.sidebar.width';
export const RAIL_WIDTH = 68;
const DEFAULT_WIDTH = 232;
const MIN_WIDTH = 188;
const MAX_WIDTH = 380;
/** Dragging the edge further left than this minimises the sidebar. */
const COLLAPSE_AT = 132;
/** Below this window width there is no room for the full sidebar. */
const NARROW_QUERY = '(max-width: 900px)';

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // ignore
  }
}
const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

export interface SidebarState {
  /** Shown as an icon rail (the user's choice, or the window is too narrow). */
  collapsed: boolean;
  /** Current width in px, the rail's width while collapsed. */
  width: number;
  dragging: boolean;
  setCollapsed: (next: boolean) => void;
  startResize: (e: PointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
}

/** Sidebar width and minimised state, remembered across launches. */
export function useSidebar(): SidebarState {
  const [collapsedPref, setCollapsedPref] = useState(() => read(COLLAPSED_KEY) === '1');
  const [width, setWidth] = useState(() => {
    const stored = Number(read(WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTH;
  });
  const [dragging, setDragging] = useState(false);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === 'function' && matchMedia(NARROW_QUERY).matches,
  );
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedPref(next);
    write(COLLAPSED_KEY, next ? '1' : '0');
  }, []);

  const startResize = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);
      const stop = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        setDragging(false);
        write(WIDTH_KEY, String(widthRef.current));
      };
      const onMove = (ev: globalThis.PointerEvent) => {
        if (ev.clientX < COLLAPSE_AT) {
          stop();
          setCollapsed(true);
          return;
        }
        setWidth(clampWidth(ev.clientX));
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    },
    [setCollapsed],
  );

  const resetWidth = useCallback(() => {
    setWidth(DEFAULT_WIDTH);
    write(WIDTH_KEY, String(DEFAULT_WIDTH));
  }, []);

  const collapsed = collapsedPref || narrow;
  return {
    collapsed,
    width: collapsed ? RAIL_WIDTH : width,
    dragging,
    setCollapsed,
    startResize,
    resetWidth,
  };
}

function isActive(route: HashRoute, path: string): boolean {
  if (path === '/') return route.path === '/';
  return route.path === path || route.path.startsWith(`${path}/`);
}

export function Sidebar({ route, state }: { route: HashRoute; state: SidebarState }) {
  const t = useT();
  const { playlists } = useStudio();
  const [flyout, setFlyout] = useState(false);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutBtnRef = useRef<HTMLButtonElement>(null);
  const { collapsed } = state;

  // The flyout only exists for the rail; navigating or expanding closes it.
  useEffect(() => setFlyout(false), [route.path, collapsed]);
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (flyoutRef.current?.contains(target) || flyoutBtnRef.current?.contains(target)) return;
      setFlyout(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFlyout(false);
        flyoutBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [flyout]);

  const settingsActive = isActive(route, '/settings');
  const brand = (
    <a className="sidebar__brand" href="#/" title={t('app.disclaimer')}>
      <span className="sidebar__logo">
        <BrandMark size={28} />
      </span>
      <span className="sidebar__brand-text">
        {t('app.name')}
        <span className="sidebar__beta">BETA</span>
      </span>
    </a>
  );

  return (
    <nav
      className={`sidebar on-rail${collapsed ? ' is-collapsed' : ''}`}
      aria-label={t('nav.library')}
    >
      <div className="sidebar__top">
        {brand}
        {!collapsed && (
          <button
            type="button"
            className="hq-icon-btn"
            onClick={() => state.setCollapsed(true)}
            aria-label={t('sidebar.minimise')}
            title={t('sidebar.minimise')}
          >
            <Icon name="chevronsLeft" size={18} />
          </button>
        )}
      </div>

      {collapsed && (
        // minimised: this button lists everything the sidebar holds
        <button
          ref={flyoutBtnRef}
          type="button"
          className={`sidebar__all${flyout ? ' is-active' : ''}`}
          onClick={() => setFlyout((open) => !open)}
          aria-expanded={flyout}
          aria-label={t('sidebar.showAll')}
          title={t('sidebar.showAll')}
        >
          <Icon name="list" size={20} />
        </button>
      )}

      <ul className="sidebar__nav">
        {NAV.map((item) => (
          <li key={item.path}>
            <a
              href={`#${item.path}`}
              className={`sidebar__link${isActive(route, item.path) ? ' is-active' : ''}`}
              aria-current={isActive(route, item.path) ? 'page' : undefined}
              aria-label={collapsed ? t(item.label) : undefined}
              title={collapsed ? t(item.label) : undefined}
            >
              <Icon name={item.icon} size={20} />
              <span className="sidebar__label">{t(item.label)}</span>
            </a>
          </li>
        ))}
      </ul>

      {!collapsed && playlists.length > 0 && (
        <div className="sidebar__section">
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
          className={`sidebar__link${settingsActive ? ' is-active' : ''}`}
          aria-label={collapsed ? t('nav.settings') : undefined}
          title={collapsed ? t('nav.settings') : undefined}
        >
          <Icon name="settings" size={20} />
          <span className="sidebar__label">{t('nav.settings')}</span>
        </a>
        {collapsed && (
          <button
            type="button"
            className="sidebar__link"
            onClick={() => state.setCollapsed(false)}
            aria-label={t('sidebar.expand')}
            title={t('sidebar.expand')}
          >
            <Icon name="chevronsRight" size={20} />
          </button>
        )}
      </div>

      {!collapsed && (
        // drag to resize, drag far left to minimise, double-click for the default width
        <button
          type="button"
          className={`sidebar__resize${state.dragging ? ' is-dragging' : ''}`}
          onPointerDown={state.startResize}
          onDoubleClick={state.resetWidth}
          aria-label={t('sidebar.resize')}
          title={t('sidebar.resize')}
          tabIndex={-1}
        >
          <span />
        </button>
      )}

      {collapsed &&
        flyout &&
        // rendered on the page, not inside the rail, so it takes the content colours
        createPortal(
          <div ref={flyoutRef} className="sidebar-flyout" role="menu">
            {NAV.map((item) => (
              <a
                key={item.path}
                role="menuitem"
                href={`#${item.path}`}
                className={`sidebar-flyout__item${isActive(route, item.path) ? ' is-active' : ''}`}
              >
                <Icon name={item.icon} size={20} />
                <span>{t(item.label)}</span>
              </a>
            ))}
            {playlists.length > 0 && <div className="sidebar-flyout__sep" />}
            {playlists.map((pl) => {
              const href = buildHref('/playlists', pl.id);
              return (
                <a
                  key={pl.id}
                  role="menuitem"
                  href={href}
                  className={`sidebar-flyout__item${route.path === href.slice(1) ? ' is-active' : ''}`}
                >
                  <Icon name="playlist" size={20} />
                  <span>{pl.name}</span>
                </a>
              );
            })}
            <div className="sidebar-flyout__sep" />
            <a
              role="menuitem"
              href="#/settings"
              className={`sidebar-flyout__item${settingsActive ? ' is-active' : ''}`}
            >
              <Icon name="settings" size={20} />
              <span>{t('nav.settings')}</span>
            </a>
          </div>,
          document.body,
        )}
    </nav>
  );
}
