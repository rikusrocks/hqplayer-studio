import {
  Artwork,
  EmptyState,
  Icon,
  buildHref,
  formatLongDuration,
  useI18n,
  useStudio,
} from '@hqps/ui';

export function PlaylistsView() {
  const { t, locale } = useI18n();
  const { playlists } = useStudio();
  return (
    <div className="rm-page">
      <h1 className="rm-h1">{t('nav.playlists')}</h1>
      {playlists.length === 0 ? (
        <EmptyState icon="playlist" title={t('playlists.empty')} hint={t('playlists.emptyHint')} />
      ) : (
        <ul className="rm-list">
          {playlists.map((pl) => (
            <li key={pl.id}>
              <a className="rm-row" href={buildHref('/playlists', pl.id)}>
                <Artwork artworkId={pl.artworkIds[0] ?? null} className="rm-row__art" />
                <span className="rm-row__text">
                  <span className="rm-row__title">{pl.name}</span>
                  <span className="rm-row__sub">
                    {t('playlists.items', { count: pl.itemCount })} ·{' '}
                    {formatLongDuration(pl.durationMs, locale)}
                  </span>
                </span>
                <Icon name="chevronRight" size={18} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
