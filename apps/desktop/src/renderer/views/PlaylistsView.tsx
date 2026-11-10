import {
  EmptyState,
  Icon,
  MenuButton,
  buildHref,
  formatDate,
  formatLongDuration,
  useI18n,
  useStudio,
} from '@hqps/ui';
import { Mosaic, ViewHeader } from './common';
import { usePlaylistActions } from './playlistActions';

export function PlaylistsView() {
  const { t, locale } = useI18n();
  const { playlists } = useStudio();
  const actions = usePlaylistActions();

  return (
    <div className="view">
      <ViewHeader
        title={t('nav.playlists')}
        subtitle={playlists.length ? String(playlists.length) : undefined}
        actions={
          <button
            type="button"
            className="hq-btn hq-btn--primary"
            onClick={() => void actions.create()}
          >
            <Icon name="plus" size={16} />
            {t('playlists.new')}
          </button>
        }
      />
      {playlists.length === 0 ? (
        <EmptyState icon="playlist" title={t('playlists.empty')} hint={t('playlists.emptyHint')} />
      ) : (
        <ul className="playlist-list">
          {playlists.map((pl) => (
            <li key={pl.id} className="playlist-row">
              <a className="playlist-row__main" href={buildHref('/playlists', pl.id)}>
                <Mosaic artworkIds={pl.artworkIds} className="playlist-row__art" />
                <span className="playlist-row__text">
                  <span className="playlist-row__name">{pl.name}</span>
                  {pl.description && <span className="playlist-row__desc">{pl.description}</span>}
                </span>
                <span className="playlist-row__meta">
                  {t('playlists.items', { count: pl.itemCount })} ·{' '}
                  {formatLongDuration(pl.durationMs, locale)}
                </span>
                <span className="playlist-row__date">
                  {t('playlist.updated', { date: formatDate(pl.updatedAt, locale) })}
                </span>
              </a>
              <MenuButton label={t('common.moreActions')} items={() => actions.menu(pl)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
