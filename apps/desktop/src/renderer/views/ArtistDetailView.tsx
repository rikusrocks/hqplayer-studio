import { StudioApiError } from '@hqps/api-client';
import {
  AlbumCard,
  AlbumGrid,
  Artwork,
  EmptyState,
  ErrorBlock,
  Icon,
  LoadingBlock,
  buildHref,
  useAsync,
  useCapabilityGate,
  useI18n,
  useStudio,
} from '@hqps/ui';
import { Section } from './common';

export function ArtistDetailView({ artistId }: { artistId: string }) {
  const { t } = useI18n();
  const { client, libraryVersion, playTracks, run, pending } = useStudio();
  const gate = useCapabilityGate();
  const artist = useAsync(
    () => client.library.artist(artistId),
    [client, artistId, libraryVersion],
  );

  if (artist.error) {
    if (artist.error instanceof StudioApiError && artist.error.code === 'not_found') {
      return <EmptyState icon="artist" title={t('artist.notFound')} />;
    }
    return <ErrorBlock error={artist.error} onRetry={artist.reload} />;
  }
  if (!artist.data) return <LoadingBlock />;
  const a = artist.data;
  const reason = gate('queue.replace');

  const playAll = async () => {
    const page = await run(() => client.library.tracks({ artistId: a.id, limit: 500 }));
    if (page && page.items.length) {
      await playTracks(
        page.items.map((tr) => tr.id),
        { source: { kind: 'artist', id: a.id, label: a.name } },
      );
    }
  };

  return (
    <div className="view">
      <div className="detail-hero detail-hero--artist">
        <div className="detail-hero__art detail-hero__art--round">
          <Artwork artworkId={a.artworkId} size="full" alt={a.name} />
        </div>
        <div className="detail-hero__body">
          <div className="detail-hero__kind">{t('nav.artists')}</div>
          <h1 className="detail-hero__title">{a.name}</h1>
          <div className="detail-hero__meta">
            {t('common.albumsCount', { count: a.albumCount })} ·{' '}
            {t('common.tracksCount', { count: a.trackCount })}
          </div>
          <div className="detail-hero__actions">
            <button
              type="button"
              className="hq-btn hq-btn--primary hq-btn--lg"
              onClick={() => void playAll()}
              disabled={!!reason || pending.has('queue') || a.trackCount === 0}
              title={reason ?? t('common.playAll')}
            >
              <Icon name="play" size={18} />
              {t('common.playAll')}
            </button>
          </div>
        </div>
      </div>
      <Section title={t('artist.albums')}>
        <AlbumGrid>
          {a.albums.map((al) => (
            <AlbumCard key={al.id} album={al} href={buildHref('/albums', al.id)} />
          ))}
        </AlbumGrid>
      </Section>
    </div>
  );
}
