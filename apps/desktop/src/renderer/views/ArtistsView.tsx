import {
  Artwork,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  SearchInput,
  buildHref,
  formatNumber,
  useDebouncedValue,
  useI18n,
  usePaged,
  useStudio,
} from '@hqps/ui';
import { useState } from 'react';
import { ViewHeader } from './common';

export function ArtistsView() {
  const { t, locale } = useI18n();
  const { client, libraryVersion } = useStudio();
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q.trim(), 200);
  const artists = usePaged(
    (offset, limit) => client.library.artists({ q: debounced || undefined, offset, limit }),
    [client, debounced, libraryVersion],
    200,
  );

  return (
    <div className="view">
      <ViewHeader
        title={t('nav.artists')}
        subtitle={artists.total ? formatNumber(artists.total, locale) : undefined}
        actions={<SearchInput value={q} onChange={setQ} placeholder={t('artists.filter')} />}
      />
      {artists.error && artists.items.length === 0 ? (
        <ErrorBlock error={artists.error} onRetry={artists.reload} />
      ) : artists.loading && artists.items.length === 0 ? (
        <LoadingBlock />
      ) : artists.items.length === 0 ? (
        <EmptyState icon="artist" title={t('artists.empty')} />
      ) : (
        <>
          <ul className="artist-list">
            {artists.items.map((ar) => (
              <li key={ar.id}>
                <a className="artist-row" href={buildHref('/artists', ar.id)}>
                  <Artwork artworkId={ar.artworkId} className="artist-row__art" />
                  <span className="artist-row__name">{ar.name}</span>
                  <span className="artist-row__meta">
                    {t('common.albumsCount', { count: ar.albumCount })} ·{' '}
                    {t('common.tracksCount', { count: ar.trackCount })}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {artists.hasMore && (
            <div className="load-more">
              <button
                type="button"
                className="hq-btn"
                onClick={artists.loadMore}
                disabled={artists.loading}
              >
                {artists.loading ? t('common.loading') : t('common.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
