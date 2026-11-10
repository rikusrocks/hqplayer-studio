import { StudioApiError } from '@hqps/api-client';
import {
  Artwork,
  EmptyState,
  ErrorBlock,
  Icon,
  LoadingBlock,
  formatDuration,
  formatLongDuration,
  useAsync,
  useCapabilityGate,
  useI18n,
  useNowPlaying,
  useStudio,
} from '@hqps/ui';

export function PlaylistView({ playlistId }: { playlistId: string }) {
  const { t, locale } = useI18n();
  const { client, playlistsVersion, libraryVersion, playPlaylist, pending } = useStudio();
  const gate = useCapabilityGate();
  const now = useNowPlaying();
  const detail = useAsync(
    () => client.playlists.get(playlistId),
    [client, playlistId, playlistsVersion, libraryVersion],
  );

  if (detail.error) {
    if (detail.error instanceof StudioApiError && detail.error.code === 'not_found') {
      return <EmptyState icon="playlist" title={t('playlist.notFound')} />;
    }
    return <ErrorBlock error={detail.error} onRetry={detail.reload} />;
  }
  if (!detail.data) return <LoadingBlock />;
  const pl = detail.data;
  const reason = gate('queue.replace');

  return (
    <div className="rm-page">
      <a className="rm-back" href="#/playlists">
        <Icon name="chevronLeft" size={18} />
        {t('nav.playlists')}
      </a>
      <h1 className="rm-h1">{pl.name}</h1>
      <div className="rm-sub">
        {t('playlists.items', { count: pl.itemCount })} ·{' '}
        {formatLongDuration(pl.durationMs, locale)}
      </div>
      <button
        type="button"
        className="hq-btn hq-btn--primary hq-btn--lg rm-wide"
        onClick={() => void playPlaylist(pl.id)}
        disabled={!!reason || pl.items.length === 0 || pending.has('queue')}
      >
        <Icon name="play" size={18} />
        {t('common.playAll')}
      </button>
      {reason && <p className="rm-reason">{reason}</p>}
      {pl.items.length === 0 ? (
        <EmptyState icon="playlist" title={t('playlist.emptyItems')} />
      ) : (
        <ol className="rm-list">
          {pl.items.map((item, i) => {
            const isCurrent = now.libraryTrack?.id === item.track.id;
            return (
              <li key={item.itemId}>
                <button
                  type="button"
                  className={`rm-row${isCurrent ? ' is-current' : ''}${item.track.available ? '' : ' is-unavailable'}`}
                  onClick={() => void playPlaylist(pl.id, item.itemId)}
                  disabled={!!reason}
                  title={t('actions.playFromHere')}
                >
                  <span className="rm-row__num">{i + 1}</span>
                  <Artwork
                    artworkId={item.track.artworkId}
                    className="rm-row__art rm-row__art--sm"
                  />
                  <span className="rm-row__text">
                    <span className="rm-row__title">{item.track.title}</span>
                    <span className="rm-row__sub">{item.track.artist}</span>
                  </span>
                  <span className="rm-row__dur">{formatDuration(item.track.durationMs)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
