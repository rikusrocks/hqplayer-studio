import type { QueueSource } from '@hqps/contracts';
import { useCallback } from 'react';
import { useDialogs } from '../data/dialogs';
import { useCapabilityGate, useStudio } from '../data/StudioProvider';
import { useT } from '../i18n/I18nProvider';
import { MenuButton, type MenuItem } from './Menu';

/**
 * The four distinct track actions, never conflated:
 *  - Play Now      → replaces the Now Playing queue and starts playback
 *  - Play Next     → inserts after the current track
 *  - Add to Queue  → appends to the end of the queue
 *  - Add to Playlist → edits a *saved* playlist only (the queue is untouched)
 */
export function useTrackActions() {
  const studio = useStudio();
  const { prompt } = useDialogs();
  const gate = useCapabilityGate();
  const t = useT();

  const addToNewPlaylist = useCallback(
    async (trackIds: string[]) => {
      const name = await prompt({
        title: t('playlists.new'),
        label: t('playlists.namePrompt'),
        confirmLabel: t('common.create'),
      });
      if (name) await studio.createPlaylist(name, trackIds);
    },
    [prompt, studio, t],
  );

  const menuItems = useCallback(
    (trackIds: string[], source?: QueueSource, extra: MenuItem[] = []): MenuItem[] => {
      const replaceReason = gate('queue.replace');
      const appendReason = gate('queue.append');
      const items: MenuItem[] = [
        {
          label: t('actions.playNow'),
          icon: 'play',
          disabled: !!replaceReason,
          title: replaceReason ?? undefined,
          onSelect: () => void studio.playTracks(trackIds, { source }),
        },
        {
          label: t('actions.playNext'),
          icon: 'chevronRight',
          disabled: !!appendReason,
          title: appendReason ?? undefined,
          onSelect: () => void studio.queueAdd(trackIds, 'next'),
        },
        {
          label: t('actions.addToQueue'),
          icon: 'queue',
          disabled: !!appendReason,
          title: appendReason ?? undefined,
          onSelect: () => void studio.queueAdd(trackIds, 'end'),
        },
        { type: 'separator' },
        { type: 'header', label: t('actions.addToPlaylist') },
        ...studio.playlists.map<MenuItem>((pl) => ({
          label: pl.name,
          icon: 'playlist',
          onSelect: () => void studio.addToPlaylist(pl, trackIds),
        })),
        {
          label: t('actions.newPlaylist'),
          icon: 'plus',
          onSelect: () => void addToNewPlaylist(trackIds),
        },
      ];
      if (extra.length) items.push({ type: 'separator' }, ...extra);
      return items;
    },
    [gate, studio, t, addToNewPlaylist],
  );

  return { menuItems, addToNewPlaylist };
}

export function TrackActionsMenu({
  trackIds,
  source,
  extra,
  label,
}: {
  trackIds: string[];
  source?: QueueSource;
  extra?: MenuItem[];
  label?: string;
}) {
  const t = useT();
  const { menuItems } = useTrackActions();
  return (
    <MenuButton
      label={label ?? t('common.moreActions')}
      items={() => menuItems(trackIds, source, extra)}
    />
  );
}

/** Stand-alone "Add to playlist" picker (e.g. for a whole album). */
export function AddToPlaylistButton({
  trackIds,
  className,
}: {
  trackIds: string[];
  className?: string;
}) {
  const t = useT();
  const studio = useStudio();
  const { addToNewPlaylist } = useTrackActions();
  return (
    <MenuButton
      label={t('actions.addToPlaylist')}
      icon="plus"
      className={className ?? 'hq-btn'}
      items={() => [
        ...studio.playlists.map<MenuItem>((pl) => ({
          label: pl.name,
          icon: 'playlist',
          onSelect: () => void studio.addToPlaylist(pl, trackIds),
        })),
        ...(studio.playlists.length ? [{ type: 'separator' } as MenuItem] : []),
        {
          label: t('actions.newPlaylist'),
          icon: 'plus',
          onSelect: () => void addToNewPlaylist(trackIds),
        },
      ]}
    >
      <span>{t('actions.addToPlaylist')}</span>
    </MenuButton>
  );
}
