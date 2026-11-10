import {
  ConnectionBadge,
  Icon,
  MockBadge,
  SearchInput,
  navigate,
  useT,
  type HashRoute,
} from '@hqps/ui';
import { useEffect, useState } from 'react';

export function TopBar({
  route,
  panelOpen,
  onTogglePanel,
}: {
  route: HashRoute;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const t = useT();
  const onSearchRoute = route.segments[0] === 'search';
  const routeQuery = onSearchRoute ? (route.query.q ?? '') : '';
  const [q, setQ] = useState(routeQuery);

  // Keep the box in sync when navigating to/away from the search view.
  useEffect(() => {
    setQ(routeQuery);
  }, [routeQuery]);

  useEffect(() => {
    if (q === routeQuery) return;
    const id = setTimeout(() => {
      if (q.trim())
        navigate(`/search?q=${encodeURIComponent(q.trim())}`, { replace: onSearchRoute });
      else if (onSearchRoute) navigate('/', { replace: true });
    }, 250);
    return () => clearTimeout(id);
  }, [q, routeQuery, onSearchRoute]);

  return (
    <header className="topbar">
      <div className="topbar__nav">
        <button
          type="button"
          className="hq-icon-btn"
          onClick={() => history.back()}
          aria-label={t('common.back')}
          title={t('common.back')}
        >
          <Icon name="chevronLeft" size={18} />
        </button>
        <button
          type="button"
          className="hq-icon-btn"
          onClick={() => history.forward()}
          aria-label="→"
          title="→"
        >
          <Icon name="chevronRight" size={18} />
        </button>
      </div>
      <SearchInput
        className="topbar__search"
        value={q}
        onChange={setQ}
        placeholder={t('search.placeholder')}
        scope="global"
      />
      <div className="topbar__right">
        <MockBadge />
        <ConnectionBadge />
        <button
          type="button"
          className={`hq-icon-btn${panelOpen ? ' is-active' : ''}`}
          onClick={onTogglePanel}
          aria-pressed={panelOpen}
          aria-label={t('player.togglePanel')}
          title={t('player.togglePanel')}
        >
          <Icon name="panel" size={18} />
        </button>
      </div>
    </header>
  );
}
