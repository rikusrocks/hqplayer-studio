import {
  Artwork,
  FormatBadge,
  ProgressBar,
  QueueSyncBanner,
  TransportControls,
  VolumeControl,
  buildHref,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';

export function NowPlayingView() {
  const t = useT();
  const { status } = useStudio();
  const now = useNowPlaying();
  const albumHref = now.libraryTrack?.albumId
    ? buildHref('/browse/album', now.libraryTrack.albumId)
    : null;

  return (
    <div className="rm-now">
      <QueueSyncBanner />
      <div className="rm-now__art">
        <Artwork artworkId={now.artworkId} size="full" alt={now.album ?? ''} />
      </div>
      <div className="rm-now__meta">
        <h1 className="rm-now__title">{now.hasTrack ? now.title : t('player.nothingPlaying')}</h1>
        {now.hasTrack && <div className="rm-now__artist">{now.artist}</div>}
        {now.hasTrack &&
          now.album &&
          (albumHref ? (
            <a className="rm-now__album" href={albumHref}>
              {now.album}
            </a>
          ) : (
            <div className="rm-now__album">{now.album}</div>
          ))}
        {now.hasTrack && <FormatBadge inputLabel={now.inputLabel} output={status.output} />}
      </div>
      <ProgressBar className="rm-now__progress" />
      <TransportControls size="lg" />
      <VolumeControl className="rm-now__volume" />
    </div>
  );
}
