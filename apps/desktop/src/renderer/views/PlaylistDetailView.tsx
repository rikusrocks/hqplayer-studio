import { StudioApiError } from '@hqps/api-client';
import type { PlaylistDetail, PlaylistItem } from '@hqps/contracts';
import {
  EmptyState,
  ErrorBlock,
  Icon,
  LoadingBlock,
  MenuButton,
  TrackActionsMenu,
  formatDuration,
  formatLongDuration,
  navigate,
  useAsync,
  useCapabilityGate,
  useI18n,
  useNowPlaying,
  useStudio,
} from '@hqps/ui';
import { useEffect, useState } from 'react';
import { Mosaic } from './common';
import { usePlaylistActions } from './playlistActions';

function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
}

export function PlaylistDetailView({ playlistId }: { playlistId: string }) {
  const { t, locale } = useI18n();
  const { client, playlistsVersion, libraryVersion, playPlaylist, run, pending } = useStudio();
  const gate = useCapabilityGate();
  const actions = usePlaylistActions();
  const now = useNowPlaying();
  const detail = useAsync(
    () => client.playlists.get(playlistId),
    [client, playlistId, playlistsVersion, libraryVersion],
  );
  const [items, setItems] = useState<PlaylistItem[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (detail.data) setItems(detail.data.items);
  }, [detail.data]);

  if (detail.error) {
    if (detail.error instanceof StudioApiError && detail.error.code === 'not_found') {
      return <EmptyState icon="playlist" title={t('playlist.notFound')} />;
    }
    return <ErrorBlock error={detail.error} onRetry={detail.reload} />;
  }
  if (!detail.data) return <LoadingBlock />;
  const pl = detail.data;
  const playReason = gate('queue.replace');

  const apply = (res: PlaylistDetail | undefined) => {
    if (res) {
      detail.setData(res);
      setItems(res.items);
    } else {
      // revert to the server's order on failure
      setItems(pl.items);
    }
  };

  const persistOrder = async (next: PlaylistItem[]) => {
    setItems(next);
    apply(
      await run(
        () =>
          client.playlists.reorder(
            pl.id,
            next.map((i) => i.itemId),
          ),
        { pending: 'playlist' },
      ),
    );
  };

  const removeItem = async (item: PlaylistItem) => {
    apply(
      await run(() => client.playlists.removeItems(pl.id, [item.itemId]), { pending: 'playlist' }),
    );
  };

  const busy = pending.has('playlist');

  return (
    <div className="view">
      <div className="detail-hero">
        <div className="detail-hero__art">
          <Mosaic artworkIds={pl.artworkIds} />
        </div>
        <div className="detail-hero__body">
          <div className="detail-hero__kind">{t('nav.playlists')}</div>
          <h1 className="detail-hero__title">{pl.name}</h1>
          {pl.description && <p className="detail-hero__desc">{pl.description}</p>}
          <div className="detail-hero__meta">
            {t('playlists.items', { count: pl.itemCount })} ·{' '}
            {formatLongDuration(pl.durationMs, locale)}
          </div>
          <div className="detail-hero__actions">
            <button
              type="button"
              className="hq-btn hq-btn--primary hq-btn--lg"
              onClick={() => void playPlaylist(pl.id)}
              disabled={!!playReason || items.length === 0 || pending.has('queue')}
              title={playReason ?? t('common.playAll')}
            >
              <Icon name="play" size={18} />
              {t('common.playAll')}
            </button>
            <button type="button" className="hq-btn" onClick={() => void actions.rename(pl)}>
              <Icon name="edit" size={16} />
              {t('common.rename')}
            </button>
            <MenuButton
              label={t('common.moreActions')}
              className="hq-icon-btn"
              items={() => actions.menu(pl, { onDeleted: () => navigate('/playlists') })}
            />
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="playlist"
          title={t('playlist.emptyItems')}
          hint={t('playlist.emptyItemsHint')}
        />
      ) : (
        <>
          <p className="hint">{t('playlist.dragHint')}</p>
          <ol className="pl-items" aria-busy={busy}>
            {items.map((item, index) => {
              const isCurrent = now.libraryTrack?.id === item.track.id;
              return (
                <li
                  key={item.itemId}
                  className={`pl-item${isCurrent ? ' is-current' : ''}${dragIndex === index ? ' is-dragging' : ''}${
                    overIndex === index && dragIndex !== null && dragIndex !== index
                      ? ' is-over'
                      : ''
                  }${item.track.available ? '' : ' is-unavailable'}`}
                  draggable={!busy}
                  onDragStart={(e) => {
                    setDragIndex(index);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', item.itemId);
                  }}
                  onDragOver={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (overIndex !== index) setOverIndex(index);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setOverIndex(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragIndex;
                    setDragIndex(null);
                    setOverIndex(null);
                    if (from === null || from === index) return;
                    void persistOrder(move(items, from, index));
                  }}
                  onDoubleClick={() => !playReason && void playPlaylist(pl.id, item.itemId)}
                >
                  <span className="pl-item__grip" aria-hidden="true">
                    <Icon name="drag" size={14} />
                  </span>
                  <span className="pl-item__num">
                    {isCurrent ? <Icon name="volume" size={14} className="hq-accent" /> : index + 1}
                  </span>
                  <span className="pl-item__title">
                    <button
                      type="button"
                      className="hq-link-btn"
                      onClick={() => void playPlaylist(pl.id, item.itemId)}
                      disabled={!!playReason}
                      title={playReason ?? t('actions.playFromHere')}
                    >
                      {item.track.title}
                    </button>
                    <span className="pl-item__artist">{item.track.artist}</span>
                  </span>
                  <span className="pl-item__album">{item.track.album}</span>
                  <span className="pl-item__fmt">{item.track.format.label}</span>
                  <span className="pl-item__dur">{formatDuration(item.track.durationMs)}</span>
                  <span className="pl-item__actions">
                    <button
                      type="button"
                      className="hq-icon-btn hq-icon-btn--sm"
                      onClick={() => void persistOrder(move(items, index, index - 1))}
                      disabled={index === 0 || busy}
                      aria-label={t('common.moveUp')}
                      title={t('common.moveUp')}
                    >
                      <Icon name="chevronUp" size={14} />
                    </button>
                    <button
                      type="button"
                      className="hq-icon-btn hq-icon-btn--sm"
                      onClick={() => void persistOrder(move(items, index, index + 1))}
                      disabled={index === items.length - 1 || busy}
                      aria-label={t('common.moveDown')}
                      title={t('common.moveDown')}
                    >
                      <Icon name="chevronDown" size={14} />
                    </button>
                    <TrackActionsMenu
                      trackIds={[item.track.id]}
                      source={{ kind: 'playlist', id: pl.id, label: pl.name }}
                      extra={[
                        {
                          label: t('playlist.removeItem'),
                          icon: 'trash',
                          danger: true,
                          onSelect: () => void removeItem(item),
                        },
                      ]}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
