import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  SearchInput,
  TrackList,
  formatNumber,
  useDebouncedValue,
  useI18n,
  usePaged,
  useStudio,
} from '@hqps/ui';
import { useState } from 'react';
import { ViewHeader } from './common';

export function TracksView() {
  const { t, locale } = useI18n();
  const { client, libraryVersion, playTracks } = useStudio();
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q.trim(), 200);
  const tracks = usePaged(
    (offset, limit) => client.library.tracks({ q: debounced || undefined, offset, limit }),
    [client, debounced, libraryVersion],
    200,
  );
  const source = debounced
    ? { kind: 'search' as const, id: null, label: debounced }
    : { kind: 'tracks' as const, id: null, label: t('nav.tracks') };

  return (
    <div className="view">
      <ViewHeader
        title={t('nav.tracks')}
        subtitle={
          tracks.total
            ? t('tracks.showing', {
                shown: formatNumber(tracks.items.length, locale),
                total: formatNumber(tracks.total, locale),
              })
            : undefined
        }
        actions={<SearchInput value={q} onChange={setQ} placeholder={t('tracks.filter')} />}
      />
      {tracks.error && tracks.items.length === 0 ? (
        <ErrorBlock error={tracks.error} onRetry={tracks.reload} />
      ) : tracks.loading && tracks.items.length === 0 ? (
        <LoadingBlock />
      ) : tracks.items.length === 0 ? (
        <EmptyState icon="track" title={t('tracks.empty')} />
      ) : (
        <>
          <TrackList
            tracks={tracks.items}
            showAlbum
            source={source}
            onPlay={(_track, index) =>
              void playTracks(
                tracks.items.slice(0, 5000).map((tr) => tr.id),
                { startIndex: index, source, mode: 'playlist' },
              )
            }
          />
          {tracks.hasMore && (
            <div className="load-more">
              <button
                type="button"
                className="hq-btn"
                onClick={tracks.loadMore}
                disabled={tracks.loading}
              >
                {tracks.loading ? t('common.loading') : t('common.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
