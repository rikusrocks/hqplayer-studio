import {
  AddToPlaylistButton,
  Artwork,
  EmptyState,
  ErrorBlock,
  Icon,
  LoadingBlock,
  TrackList,
  buildHref,
  formatLongDuration,
  useAsync,
  useCapabilityGate,
  useI18n,
  useStudio,
} from '@hqps/ui';
import { StudioApiError } from '@hqps/api-client';

export function AlbumDetailView({ albumId }: { albumId: string }) {
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
  const trackIds = a.tracks.map((tr) => tr.id);
  const playReason = gate('queue.replace');
  const appendReason = gate('queue.append');
  const source = { kind: 'album' as const, id: a.id, label: a.title };
  const meta = [
    a.year,
    a.genre,
    t('common.tracksCount', { count: a.trackCount }),
    a.discCount > 1 ? t('common.discs', { count: a.discCount }) : null,
    formatLongDuration(a.durationMs, locale),
  ].filter(Boolean);

  return (
    <div className="view">
      <div className="detail-hero">
        <div className="detail-hero__art">
          <Artwork artworkId={a.artworkId} size="full" alt={a.title} />
        </div>
        <div className="detail-hero__body">
          <div className="detail-hero__kind">{t('nav.albums')}</div>
          <h1 className="detail-hero__title">{a.title}</h1>
          <a
            className="detail-hero__artist"
            href={
              a.albumArtistId
                ? buildHref('/artists', a.albumArtistId)
                : buildHref('/search', { q: a.albumArtist })
            }
          >
            {a.albumArtist}
          </a>
          <div className="detail-hero__meta">
            {meta.join(' · ')}
            <span className="hq-badge">{a.formatLabel}</span>
          </div>
          {a.folder && (
            <div className="detail-hero__folder hq-mono">
              {t('album.folder', { folder: a.folder })}
            </div>
          )}
          <div className="detail-hero__actions">
            <button
              type="button"
              className="hq-btn hq-btn--primary hq-btn--lg"
              onClick={() => void playAlbum(a.id)}
              disabled={!!playReason || pending.has('queue') || a.tracks.length === 0}
              title={playReason ?? t('actions.playAlbum')}
            >
              <Icon name="play" size={18} />
              {t('actions.playAlbum')}
            </button>
            <button
              type="button"
              className="hq-btn"
              onClick={() => void queueAdd(trackIds, 'next')}
              disabled={!!appendReason || trackIds.length === 0}
              title={appendReason ?? t('actions.playNext')}
            >
              <Icon name="chevronRight" size={16} />
              {t('actions.playNext')}
            </button>
            <button
              type="button"
              className="hq-btn"
              onClick={() => void queueAdd(trackIds, 'end')}
              disabled={!!appendReason || trackIds.length === 0}
              title={appendReason ?? t('actions.addToQueue')}
            >
              <Icon name="queue" size={16} />
              {t('actions.addToQueue')}
            </button>
            <AddToPlaylistButton trackIds={trackIds} />
          </div>
        </div>
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
        showArtist
        source={source}
        onPlay={(track) => void playAlbum(a.id, track.id)}
      />
    </div>
  );
}
