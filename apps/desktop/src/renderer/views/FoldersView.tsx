import type { FolderEntry } from '@hqps/contracts';
import {
  EmptyState,
  ErrorBlock,
  Icon,
  LoadingBlock,
  TrackList,
  buildHref,
  useAsync,
  useCapabilityGate,
  useI18n,
  useStudio,
} from '@hqps/ui';
import { ViewHeader } from './common';

function folderHref(rootId: string, path: string): string {
  return buildHref('/folders', rootId, ...path.split('/').filter(Boolean));
}

export function FoldersView({ rootId, path = '' }: { rootId?: string; path?: string }) {
  const { t } = useI18n();
  const { client, libraryVersion, playTracks, pending } = useStudio();
  const gate = useCapabilityGate();
  const listing = useAsync(
    () => client.library.folders(rootId ? { rootId, path } : {}),
    [client, rootId, path, libraryVersion],
  );

  if (listing.error) return <ErrorBlock error={listing.error} onRetry={listing.reload} />;
  if (!listing.data) return <LoadingBlock />;
  const l = listing.data;
  const segments = path.split('/').filter(Boolean);
  const title = rootId ? (segments[segments.length - 1] ?? l.rootName) : t('folders.roots');
  const source = { kind: 'folder' as const, id: rootId ? `${rootId}:${path}` : null, label: title };
  const reason = gate('queue.replace');

  return (
    <div className="view">
      <nav className="breadcrumbs" aria-label={t('nav.folders')}>
        <a href="#/folders">{t('folders.roots')}</a>
        {rootId && (
          <>
            <Icon name="chevronRight" size={14} />
            <a href={folderHref(rootId, '')}>{l.rootName}</a>
          </>
        )}
        {rootId &&
          segments.map((seg, i) => (
            <span key={`${seg}:${i}`} className="breadcrumbs__seg">
              <Icon name="chevronRight" size={14} />
              <a href={folderHref(rootId, segments.slice(0, i + 1).join('/'))}>{seg}</a>
            </span>
          ))}
      </nav>

      <ViewHeader
        title={title}
        icon="folder"
        actions={
          l.tracks.length > 0 && (
            <button
              type="button"
              className="hq-btn hq-btn--primary"
              onClick={() =>
                void playTracks(
                  l.tracks.map((tr) => tr.id),
                  { source },
                )
              }
              disabled={!!reason || pending.has('queue')}
              title={reason ?? t('folders.playFolder')}
            >
              <Icon name="play" size={16} />
              {t('folders.playFolder')}
            </button>
          )
        }
      />

      {l.folders.length === 0 && l.tracks.length === 0 ? (
        <EmptyState icon="folder" title={rootId ? t('folders.empty') : t('folders.noRoots')} />
      ) : (
        <>
          {l.folders.length > 0 && (
            <ul className="folder-list">
              {l.folders.map((f: FolderEntry) => (
                <li key={`${f.rootId}:${f.path}`}>
                  <a className="folder-row" href={folderHref(f.rootId, f.path)}>
                    <Icon name="folder" size={18} />
                    <span className="folder-row__name">{f.name}</span>
                    <span className="folder-row__count">
                      {t('common.tracksCount', { count: f.trackCount })}
                    </span>
                    <Icon name="chevronRight" size={16} />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {l.tracks.length > 0 && (
            <TrackList
              tracks={l.tracks}
              numbering="track"
              showAlbum
              source={source}
              onPlay={(_tr, index) =>
                void playTracks(
                  l.tracks.map((tr) => tr.id),
                  { startIndex: index, source },
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
}
