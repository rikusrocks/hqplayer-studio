import {
  AlbumCard,
  AlbumGrid,
  Artwork,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  TrackList,
  buildHref,
  useAsync,
  useI18n,
  useStudio,
} from '@hqps/ui';
import { Section, ViewHeader } from './common';

export function SearchView({ query }: { query: string }) {
  const { t } = useI18n();
  const { client, libraryVersion, playTracks } = useStudio();
  const q = query.trim();
  const results = useAsync(async () => {
    if (!q) return null;
    const [albums, artists, tracks] = await Promise.all([
      client.library.albums({ q, limit: 12 }),
      client.library.artists({ q, limit: 12 }),
      client.library.tracks({ q, limit: 50 }),
    ]);
    return { albums, artists, tracks };
  }, [client, q, libraryVersion]);

  if (!q) return <EmptyState icon="search" title={t('nav.search')} hint={t('search.hint')} />;

  return (
    <div className="view">
      <ViewHeader title={`“${q}”`} icon="search" />
      {results.error ? (
        <ErrorBlock error={results.error} onRetry={results.reload} />
      ) : !results.data ? (
        <LoadingBlock />
      ) : results.data.albums.total + results.data.artists.total + results.data.tracks.total ===
        0 ? (
        <EmptyState icon="search" title={t('search.noResults', { q })} />
      ) : (
        <>
          {results.data.albums.items.length > 0 && (
            <Section title={`${t('search.albums')} (${results.data.albums.total})`}>
              <AlbumGrid dense>
                {results.data.albums.items.map((a) => (
                  <AlbumCard key={a.id} album={a} href={buildHref('/albums', a.id)} />
                ))}
              </AlbumGrid>
            </Section>
          )}
          {results.data.artists.items.length > 0 && (
            <Section title={`${t('search.artists')} (${results.data.artists.total})`}>
              <div className="chip-row">
                {results.data.artists.items.map((ar) => (
                  <a key={ar.id} className="artist-chip" href={buildHref('/artists', ar.id)}>
                    <Artwork artworkId={ar.artworkId} className="artist-chip__art" />
                    <span>{ar.name}</span>
                  </a>
                ))}
              </div>
            </Section>
          )}
          {results.data.tracks.items.length > 0 && (
            <Section title={`${t('search.tracks')} (${results.data.tracks.total})`}>
              <TrackList
                tracks={results.data.tracks.items}
                showAlbum
                source={{ kind: 'search', id: null, label: q }}
                onPlay={(_tr, index) =>
                  void playTracks(
                    results.data!.tracks.items.map((tr) => tr.id),
                    { startIndex: index, source: { kind: 'search', id: null, label: q } },
                  )
                }
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
