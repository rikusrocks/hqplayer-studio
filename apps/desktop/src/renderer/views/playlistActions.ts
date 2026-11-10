import type { PlaylistSummary } from '@hqps/contracts';
import { navigate, useDialogs, useStudio, useT, type MenuItem } from '@hqps/ui';
import { useCallback } from 'react';

/** Rename / duplicate / delete for saved playlists (Studio-owned data, never engine state). */
export function usePlaylistActions() {
  const t = useT();
  const { client, run, refreshPlaylists, playPlaylist } = useStudio();
  const { prompt, confirm } = useDialogs();

  const create = useCallback(async () => {
    const name = await prompt({
      title: t('playlists.new'),
      label: t('playlists.namePrompt'),
      confirmLabel: t('common.create'),
    });
    if (!name) return;
    const created = await run(() => client.playlists.create({ name }), {
      pending: 'playlist',
      success: t('playlist.created', { name }),
    });
    if (created) {
      await refreshPlaylists();
      navigate(`/playlists/${encodeURIComponent(created.id)}`);
    }
  }, [client, prompt, refreshPlaylists, run, t]);

  const rename = useCallback(
    async (pl: Pick<PlaylistSummary, 'id' | 'name'>) => {
      const name = await prompt({
        title: t('common.rename'),
        label: t('playlists.renamePrompt'),
        defaultValue: pl.name,
        confirmLabel: t('common.save'),
      });
      if (!name || name === pl.name) return;
      const res = await run(() => client.playlists.update(pl.id, { name }), {
        pending: 'playlist',
      });
      if (res) await refreshPlaylists();
      return res;
    },
    [client, prompt, refreshPlaylists, run, t],
  );

  const duplicate = useCallback(
    async (pl: Pick<PlaylistSummary, 'id' | 'name'>) => {
      const res = await run(
        () => client.playlists.duplicate(pl.id, t('playlist.copyName', { name: pl.name })),
        {
          pending: 'playlist',
        },
      );
      if (res) {
        await refreshPlaylists();
        navigate(`/playlists/${encodeURIComponent(res.id)}`);
      }
    },
    [client, refreshPlaylists, run, t],
  );

  const remove = useCallback(
    async (pl: Pick<PlaylistSummary, 'id' | 'name'>, after?: () => void) => {
      const ok = await confirm({
        title: t('playlists.deleteTitle'),
        message: t('playlists.deleteConfirm', { name: pl.name }),
        danger: true,
        confirmLabel: t('common.delete'),
      });
      if (!ok) return;
      const res = await run(() => client.playlists.remove(pl.id), {
        pending: 'playlist',
        success: t('playlist.deleted'),
      });
      if (res) {
        await refreshPlaylists();
        after?.();
      }
    },
    [client, confirm, refreshPlaylists, run, t],
  );

  const menu = useCallback(
    (pl: PlaylistSummary, opts: { onDeleted?: () => void } = {}): MenuItem[] => [
      {
        label: t('common.playAll'),
        icon: 'play',
        onSelect: () => void playPlaylist(pl.id),
        disabled: pl.itemCount === 0,
      },
      { type: 'separator' },
      { label: t('common.rename'), icon: 'edit', onSelect: () => void rename(pl) },
      { label: t('common.duplicate'), icon: 'copy', onSelect: () => void duplicate(pl) },
      { type: 'separator' },
      {
        label: t('common.delete'),
        icon: 'trash',
        danger: true,
        onSelect: () => void remove(pl, opts.onDeleted),
      },
    ],
    [duplicate, playPlaylist, remove, rename, t],
  );

  return { create, rename, duplicate, remove, menu };
}
