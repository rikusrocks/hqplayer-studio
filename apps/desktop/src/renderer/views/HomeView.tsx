import {
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
import type { CSSProperties } from 'react';
import { AlbumTile } from './AlbumTile';
import { Mosaic, Section } from './common';

/** How many of the newest albums the home wall shows. */
const RECENT_COUNT = 36;

/** Home is two things only: what was added lately, and the playlists. */
export function HomeView() {
  const { t } = useI18n();
  const { client, libraryVersion, playlists, stats, playPlaylist, pending } = useStudio();
  const playReason = useCapabilityGate()('queue.replace');
  const recent = useAsync(
    () => client.library.albums({ sort: 'added', limit: RECENT_COUNT }),
    [client, libraryVersion],
  );

  const libraryEmpty = stats
    ? stats.trackCount === 0
    : recent.data
      ? recent.data.total === 0
      : false;

  return (
    <div className="view home">
      {libraryEmpty ? (
        <EmptyState
          icon="library"
          title={t('home.emptyLibrary')}
          action={
            <a className="hq-btn hq-btn--primary" href="#/settings/library">
              <Icon name="plus" size={16} />
              {t('settings.addRoot')}
            </a>
          }
        />
      ) : (
        <Section
          title={t('home.recentlyAdded')}
          action={
            <a className="section__more" href="#/albums?sort=added">
              {t('home.viewAll')}
            </a>
          }
        >
          {recent.error ? (
            <ErrorBlock error={recent.error} onRetry={recent.reload} />
          ) : !recent.data ? (
            <LoadingBlock />
          ) : (
            <div className="hq-album-grid">
              {recent.data.items.map((a, i) => (
                <AlbumTile key={a.id} album={a} index={i} />
              ))}
            </div>
          )}
        </Section>
      )}

      {playlists.length > 0 && (
        <Section
          title={t('home.playlists')}
          action={
            <a className="section__more" href="#/playlists">
              {t('home.viewAll')}
            </a>
          }
        >
          <div className="pl-tiles">
            {playlists.map((pl, i) => (
              <div key={pl.id} className="pl-tile" style={{ '--i': i } as CSSProperties}>
                <a href={buildHref('/playlists', pl.id)} aria-label={pl.name} tabIndex={-1}>
                  <Mosaic artworkIds={pl.artworkIds} className="pl-tile__art" />
                </a>
                <a className="pl-tile__text" href={buildHref('/playlists', pl.id)}>
                  <span className="pl-tile__name">{pl.name}</span>
                  <span className="pl-tile__meta">
                    {t('playlists.items', { count: pl.itemCount })}
                  </span>
                </a>
                <button
                  type="button"
                  className="pl-tile__play"
                  onClick={() => void playPlaylist(pl.id)}
                  disabled={!!playReason || pl.itemCount === 0 || pending.has('queue')}
                  title={playReason ?? t('common.play')}
                  aria-label={`${t('common.play')}: ${pl.name}`}
                >
                  <Icon name="play" size={22} />
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
