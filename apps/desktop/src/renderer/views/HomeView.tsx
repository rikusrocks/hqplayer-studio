import {
  AlbumCard,
  AlbumGrid,
  Artwork,
  EmptyState,
  ErrorBlock,
  FormatBadge,
  Icon,
  LoadingBlock,
  ProgressBar,
  TransportControls,
  buildHref,
  formatLongDuration,
  formatNumber,
  useAsync,
  useI18n,
  useNowPlaying,
  useStudio,
} from '@hqps/ui';
import { Mosaic, Section } from './common';

export function HomeView() {
  const { t, locale } = useI18n();
  const { client, libraryVersion, playlists, stats, status } = useStudio();
  const now = useNowPlaying();
  const recent = useAsync(
    () => client.library.albums({ sort: 'added', limit: 12 }),
    [client, libraryVersion],
  );

  const libraryEmpty = stats
    ? stats.trackCount === 0
    : recent.data
      ? recent.data.total === 0
      : false;

  return (
    <div className="view home">
      {now.hasTrack && (
        <div className="home-now hq-card">
          <div className="home-now__art">
            <Artwork artworkId={now.artworkId} size="full" />
          </div>
          <div className="home-now__body">
            <div className="home-now__label">{t('home.nowPlaying')}</div>
            <div className="home-now__title">{now.title}</div>
            <div className="home-now__artist">
              {[now.artist, now.album].filter(Boolean).join(' — ')}
            </div>
            <FormatBadge inputLabel={now.inputLabel} output={status.output} />
            <div className="home-now__controls">
              <TransportControls size="sm" />
              <ProgressBar />
            </div>
          </div>
        </div>
      )}

      {stats && (
        <div className="home-stats">
          <Stat value={formatNumber(stats.trackCount, locale)} label={t('home.statsTracks')} />
          <Stat value={formatNumber(stats.albumCount, locale)} label={t('home.statsAlbums')} />
          <Stat value={formatNumber(stats.artistCount, locale)} label={t('home.statsArtists')} />
          <Stat
            value={formatLongDuration(stats.totalDurationMs, locale)}
            label={t('col.duration')}
          />
          {stats.unavailableTrackCount > 0 && (
            <Stat
              value={formatNumber(stats.unavailableTrackCount, locale)}
              label={t('home.statsUnavailable')}
              warn
            />
          )}
        </div>
      )}

      {libraryEmpty ? (
        <EmptyState
          icon="library"
          title={t('home.emptyLibrary')}
          hint={t('home.emptyLibraryHint')}
          action={
            <a className="hq-btn hq-btn--primary" href="#/settings/library">
              {t('home.goSettings')}
            </a>
          }
        />
      ) : (
        <Section
          title={t('home.recentlyAdded')}
          action={
            <a className="hq-btn hq-btn--ghost hq-btn--sm" href="#/albums?sort=added">
              {t('home.viewAll')}
            </a>
          }
        >
          {recent.error ? (
            <ErrorBlock error={recent.error} onRetry={recent.reload} />
          ) : !recent.data ? (
            <LoadingBlock />
          ) : (
            <AlbumGrid dense>
              {recent.data.items.map((a) => (
                <AlbumCard key={a.id} album={a} href={buildHref('/albums', a.id)} />
              ))}
            </AlbumGrid>
          )}
        </Section>
      )}

      {playlists.length > 0 && (
        <Section
          title={t('home.playlists')}
          action={
            <a className="hq-btn hq-btn--ghost hq-btn--sm" href="#/playlists">
              {t('home.viewAll')}
            </a>
          }
        >
          <div className="pl-tiles">
            {playlists.slice(0, 8).map((pl) => (
              <a key={pl.id} className="pl-tile" href={buildHref('/playlists', pl.id)}>
                <Mosaic artworkIds={pl.artworkIds} className="pl-tile__art" />
                <span className="pl-tile__text">
                  <span className="pl-tile__name">{pl.name}</span>
                  <span className="pl-tile__meta">
                    {t('playlists.items', { count: pl.itemCount })}
                  </span>
                </span>
                <Icon name="chevronRight" size={16} />
              </a>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Stat({ value, label, warn }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className={`home-stat${warn ? ' home-stat--warn' : ''}`}>
      <div className="home-stat__value">{value}</div>
      <div className="home-stat__label">{label}</div>
    </div>
  );
}
