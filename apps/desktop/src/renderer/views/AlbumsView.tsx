import type { AlbumSort } from '@hqps/contracts';
import {
  AlbumCard,
  AlbumGrid,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  SearchInput,
  buildHref,
  formatNumber,
  navigate,
  useDebouncedValue,
  useHashRoute,
  useI18n,
  usePaged,
  useStudio,
} from '@hqps/ui';
import { useState } from 'react';
import { ViewHeader } from './common';

const SORTS: AlbumSort[] = ['artist', 'title', 'year', 'added'];

export function AlbumsView() {
  const { t, locale } = useI18n();
  const { client, libraryVersion } = useStudio();
  const route = useHashRoute();
  const sortParam = route.query.sort as AlbumSort | undefined;
  const sort: AlbumSort = sortParam && SORTS.includes(sortParam) ? sortParam : 'artist';
  const [q, setQ] = useState(route.query.q ?? '');
  const debounced = useDebouncedValue(q.trim(), 200);

  const albums = usePaged(
    (offset, limit) => client.library.albums({ q: debounced || undefined, sort, offset, limit }),
    [client, debounced, sort, libraryVersion],
    120,
  );

  return (
    <div className="view">
      <ViewHeader
        title={t('nav.albums')}
        subtitle={
          albums.total
            ? t('common.albumsCount', { count: formatNumber(albums.total, locale) })
            : undefined
        }
        actions={
          <>
            <SearchInput value={q} onChange={setQ} placeholder={t('albums.filter')} />
            <label className="inline-field">
              <span>{t('albums.sort')}</span>
              <select
                className="hq-select"
                value={sort}
                onChange={(e) =>
                  navigate(buildHref('/albums', { sort: e.target.value, q: q || undefined }), {
                    replace: true,
                  })
                }
              >
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`albums.sort.${s}`)}
                  </option>
                ))}
              </select>
            </label>
          </>
        }
      />
      {albums.error && albums.items.length === 0 ? (
        <ErrorBlock error={albums.error} onRetry={albums.reload} />
      ) : albums.loading && albums.items.length === 0 ? (
        <LoadingBlock />
      ) : albums.items.length === 0 ? (
        <EmptyState icon="album" title={t('albums.empty')} />
      ) : (
        <>
          <AlbumGrid>
            {albums.items.map((a) => (
              <AlbumCard key={a.id} album={a} href={buildHref('/albums', a.id)} />
            ))}
          </AlbumGrid>
          {albums.hasMore && (
            <div className="load-more">
              <button
                type="button"
                className="hq-btn"
                onClick={albums.loadMore}
                disabled={albums.loading}
              >
                {albums.loading ? t('common.loading') : t('common.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
