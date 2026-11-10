import {
  AlbumCard,
  AlbumGrid,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  SearchInput,
  buildHref,
  useDebouncedValue,
  useI18n,
  usePaged,
  useStudio,
} from '@hqps/ui';
import { useState } from 'react';

export function BrowseView({ initialQuery }: { initialQuery: string }) {
  const { t } = useI18n();
  const { client, libraryVersion } = useStudio();
  const [q, setQ] = useState(initialQuery);
  const debounced = useDebouncedValue(q.trim(), 250);
  const albums = usePaged(
    (offset, limit) =>
      client.library.albums({
        q: debounced || undefined,
        sort: debounced ? 'artist' : 'added',
        offset,
        limit,
      }),
    [client, debounced, libraryVersion],
    60,
  );

  return (
    <div className="rm-page">
      <SearchInput
        value={q}
        onChange={setQ}
        placeholder={t('search.placeholder')}
        className="rm-search"
      />
      {albums.error && albums.items.length === 0 ? (
        <ErrorBlock error={albums.error} onRetry={albums.reload} />
      ) : albums.loading && albums.items.length === 0 ? (
        <LoadingBlock />
      ) : albums.items.length === 0 ? (
        <EmptyState
          icon="album"
          title={debounced ? t('search.noResults', { q: debounced }) : t('albums.empty')}
        />
      ) : (
        <>
          <AlbumGrid dense>
            {albums.items.map((a) => (
              <AlbumCard key={a.id} album={a} href={buildHref('/browse/album', a.id)} />
            ))}
          </AlbumGrid>
          {albums.hasMore && (
            <div className="rm-more">
              <button
                type="button"
                className="hq-btn hq-btn--lg"
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
