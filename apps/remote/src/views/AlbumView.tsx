import { StudioApiError } from '@hqps/api-client';
import {
  Artwork,
  EmptyState,
  ErrorBlock,
  Icon,
  LoadingBlock,
  TrackList,
  formatLongDuration,
  useAsync,
  useCapabilityGate,
  useI18n,
  useStudio,
} from '@hqps/ui';

export function AlbumView({ albumId }: { albumId: string }) {
  const { t, locale } = useI18n();
  const { client, libraryVersion, playAlbum, queueAdd, pending } = useStudio();
  const gate = useCapabilityGate();
  const album = useAsync(() => client.library.album(albumId), [client, albumId, libraryVersion]);

  if (album.error) {
    if (album.error instanceof StudioApiError && album.error.code === 'not_found') {
      return <EmptyState icon="album" title={t('album.notFound')} />;
    }
    return <ErrorBlock error={album.error} onRetry={album.reload} />;
  }
  if (!album.data) return <LoadingBlock />;
  const a = album.data;
  const playReason = gate('queue.replace');
  const appendReason = gate('queue.append');

  return (
    <div className="rm-page">
      <a className="rm-back" href="#/browse">
        <Icon name="chevronLeft" size={18} />
        {t('nav.browse')}
      </a>
      <div className="rm-album-hero">
        <div className="rm-album-hero__art">
          <Artwork artworkId={a.artworkId} size="full" alt={a.title} />
        </div>
        <h1 className="rm-album-hero__title">{a.title}</h1>
        <div className="rm-album-hero__artist">{a.albumArtist}</div>
        <div className="rm-album-hero__meta">
          {[
            a.year,
            t('common.tracksCount', { count: a.trackCount }),
            formatLongDuration(a.durationMs, locale),
          ]
            .filter(Boolean)
            .join(' · ')}
          <span className="hq-badge">{a.formatLabel}</span>
        </div>
        <div className="rm-album-hero__actions">
          <button
            type="button"
            className="hq-btn hq-btn--primary hq-btn--lg"
            onClick={() => void playAlbum(a.id)}
            disabled={!!playReason || pending.has('queue')}
            title={playReason ?? undefined}
          >
            <Icon name="play" size={18} />
            {t('actions.playAlbum')}
          </button>
          <button
            type="button"
            className="hq-btn hq-btn--lg"
            onClick={() =>
              void queueAdd(
                a.tracks.map((tr) => tr.id),
                'end',
              )
            }
            disabled={!!appendReason}
            title={appendReason ?? undefined}
          >
            <Icon name="queue" size={18} />
            {t('actions.addToQueue')}
          </button>
        </div>
        {playReason && <p className="rm-reason">{playReason}</p>}
      </div>
      {!a.available && (
        <div className="hq-banner hq-banner--warn">
          <Icon name="warning" size={16} />
          <span>{t('album.unavailable')}</span>
        </div>
      )}
      <TrackList
        tracks={a.tracks}
        groupByDisc
        numbering="track"
        compact
        source={{ kind: 'album', id: a.id, label: a.title }}
        onPlay={(track) => void playAlbum(a.id, track.id)}
      />
    </div>
  );
}
