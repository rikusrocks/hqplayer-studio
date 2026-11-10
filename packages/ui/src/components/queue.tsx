import { canUse, type EngineQueue } from '@hqps/contracts';
import { useEffect, useState } from 'react';
import { useDialogs } from '../data/dialogs';
import { useCapabilityGate, useStudio } from '../data/StudioProvider';
import { formatDuration } from '../format';
import { useT } from '../i18n/I18nProvider';
import { Icon } from './Icon';
import { Artwork, EmptyState, Spinner } from './basics';

/**
 * Shown when Studio's planned queue and what HQPlayer actually plays disagree.
 * Studio never silently overwrites the engine; the user decides which side wins:
 * - "Follow HQPlayer" sends nothing to HQPlayer (always safe, works without control rights);
 * - "Replace HQPlayer's queue" stops HQPlayer and loads Studio's queue (needs control, confirmed).
 */
export function QueueSyncBanner() {
  const { queue, queueTakeover, queueFollow, pending, serverReachable } = useStudio();
  const gate = useCapabilityGate();
  const { confirm } = useDialogs();
  const t = useT();
  if (!serverReachable) return null;
  if (queue.sync.state === 'engine_offline' && queue.items.length > 0) {
    return (
      <div className="hq-banner hq-banner--muted" role="status">
        <Icon name="info" size={16} />
        <span>{t('queue.engineOffline')}</span>
      </div>
    );
  }
  if (queue.sync.state !== 'out_of_sync') return null;
  const takeoverReason = gate('queue.replace');
  const busy = pending.has('takeover') || pending.has('follow');
  const detail = queue.sync.code
    ? t(`queue.sync.${queue.sync.code}`)
    : (queue.sync.reason ?? t('queue.outOfSyncHint'));
  return (
    <div className="hq-banner hq-banner--warn hq-banner--stacked" role="alert">
      <Icon name="warning" size={18} />
      <div className="hq-banner__body">
        <strong>{t('queue.outOfSync')}</strong>
        <span>{detail}</span>
      </div>
      <div className="hq-banner__actions">
        <button
          type="button"
          className="hq-btn hq-btn--primary hq-btn--sm"
          onClick={() => void queueFollow()}
          disabled={busy}
          title={t('queue.followHint')}
        >
          {pending.has('follow') ? <Spinner size={14} /> : <Icon name="check" size={14} />}
          {t('queue.follow')}
        </button>
        <button
          type="button"
          className="hq-btn hq-btn--sm"
          onClick={async () => {
            const ok = await confirm({
              title: t('queue.takeover'),
              message: t('queue.takeoverConfirm', { count: queue.items.length }),
              confirmLabel: t('queue.takeover'),
            });
            if (ok) await queueTakeover();
          }}
          disabled={!!takeoverReason || busy}
          title={takeoverReason ?? t('queue.takeoverHint')}
        >
          {pending.has('takeover') ? <Spinner size={14} /> : <Icon name="refresh" size={14} />}
          {t('queue.takeover')}
        </button>
      </div>
    </div>
  );
}

/** The Now Playing queue (shared by Desktop side panel and Remote). */
export function QueueList({ large = false }: { large?: boolean }) {
  const { queue, queueJump, queueRemove, queueClear, pending } = useStudio();
  const gate = useCapabilityGate();
  const { confirm } = useDialogs();
  const t = useT();
  const jumpReason = gate('queue.select');
  const editReason = gate('queue.replace');

  if (queue.items.length === 0) {
    return <EmptyOrEngineQueue large={large} />;
  }

  return (
    <div className={`hq-queue${large ? ' hq-queue--large' : ''}`}>
      <QueueSyncBanner />
      <div className="hq-queue__meta">
        <div className="hq-queue__source">
          {queue.source && <span>{t('queue.source', { label: queue.source.label })}</span>}
          <span className="hq-badge">
            {t(queue.mode === 'album' ? 'queue.mode.album' : 'queue.mode.playlist')}
          </span>
          <span className="hq-muted">{t('common.tracksCount', { count: queue.items.length })}</span>
        </div>
        <button
          type="button"
          className="hq-btn hq-btn--ghost hq-btn--sm"
          disabled={!!editReason || pending.has('queue')}
          title={editReason ?? t('queue.clear')}
          onClick={async () => {
            const ok = await confirm({
              title: t('queue.clear'),
              message: t('queue.clearConfirm'),
              danger: true,
              confirmLabel: t('queue.clear'),
            });
            if (ok) await queueClear();
          }}
        >
          <Icon name="trash" size={14} />
          {t('queue.clear')}
        </button>
      </div>
      <ol className="hq-queue__list">
        {queue.items.map((item, index) => {
          const isCurrent = index === queue.currentIndex;
          const isPast = queue.currentIndex !== null && index < queue.currentIndex;
          return (
            <li
              key={item.itemId}
              className={`hq-queue__item${isCurrent ? ' is-current' : ''}${isPast ? ' is-past' : ''}${item.track.available ? '' : ' is-unavailable'}`}
            >
              <button
                type="button"
                className="hq-queue__main"
                // Desktop: double-click (or Enter) plays, like other music players; a stray
                // single click never interrupts the music. Touch remote: tap plays.
                onClick={large ? () => void queueJump(index) : undefined}
                onDoubleClick={large ? undefined : () => void queueJump(index)}
                onKeyDown={
                  large
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void queueJump(index);
                        }
                      }
                }
                disabled={!!jumpReason || isCurrent}
                title={jumpReason ?? t(large ? 'queue.jump' : 'queue.jumpDouble')}
                aria-current={isCurrent ? 'true' : undefined}
              >
                <Artwork artworkId={item.track.artworkId} className="hq-queue__art" />
                <span className="hq-queue__text">
                  <span className="hq-queue__title">{item.track.title}</span>
                  <span className="hq-queue__artist">{item.track.artist}</span>
                </span>
                <span className="hq-queue__dur">
                  {isCurrent ? (
                    <Icon name="volume" size={14} className="hq-accent" />
                  ) : (
                    formatDuration(item.track.durationMs)
                  )}
                </span>
              </button>
              <button
                type="button"
                className="hq-icon-btn hq-icon-btn--sm hq-queue__remove"
                onClick={() => void queueRemove([item.itemId])}
                disabled={!!editReason || isCurrent || pending.has('queue')}
                title={editReason ?? t('common.remove')}
                aria-label={`${t('common.remove')}: ${item.track.title}`}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * When Studio has not queued anything but HQPlayer is connected with its own playlist (e.g. the
 * user queued music in HQPlayer itself), show that playlist read-only instead of "queue empty".
 */
function EmptyOrEngineQueue({ large }: { large: boolean }) {
  const { client, status, capabilities, isMock } = useStudio();
  const t = useT();
  const [engineQueue, setEngineQueue] = useState<EngineQueue | null>(null);
  const live = !isMock && status.connection === 'connected' && canUse(capabilities, 'queue.read');
  const trackKey = `${status.trackIndex}|${status.trackCount}|${status.track?.uri ?? status.track?.title ?? ''}`;

  useEffect(() => {
    if (!live) {
      setEngineQueue(null);
      return;
    }
    let cancelled = false;
    client.engine
      .queue()
      .then((q) => {
        if (!cancelled) setEngineQueue(q);
      })
      .catch(() => {
        if (!cancelled) setEngineQueue(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, live, trackKey]);

  if (!engineQueue || engineQueue.entries.length === 0) {
    return (
      <div className="hq-queue">
        <QueueSyncBanner />
        <EmptyState icon="queue" title={t('queue.empty')} hint={t('queue.emptyHint')} />
      </div>
    );
  }
  const current = status.trackIndex ?? engineQueue.currentIndex;
  return (
    <div className={`hq-queue${large ? ' hq-queue--large' : ''}`}>
      <div className="hq-queue__meta">
        <div className="hq-queue__source">
          <span>{t('engine.queue.title')}</span>
          {engineQueue.albumMode !== null && (
            <span className="hq-badge">
              {t(engineQueue.albumMode ? 'queue.mode.album' : 'queue.mode.playlist')}
            </span>
          )}
          <span className="hq-muted">
            {t('common.tracksCount', { count: engineQueue.entries.length })}
          </span>
        </div>
      </div>
      <p className="hint hq-queue__hint">{t('engine.queue.readOnlyHint')}</p>
      <ol className="hq-queue__list">
        {engineQueue.entries.map((e) => {
          const isCurrent = e.index === current;
          const isPast = current !== null && e.index < current;
          return (
            <li
              key={e.index}
              className={`hq-queue__item${isCurrent ? ' is-current' : ''}${isPast ? ' is-past' : ''}`}
              aria-current={isCurrent ? 'true' : undefined}
            >
              <div className="hq-queue__main hq-queue__main--static">
                <span className="hq-queue__num hq-muted">{e.index + 1}</span>
                <span className="hq-queue__text">
                  <span className="hq-queue__title">{e.title ?? '—'}</span>
                  <span className="hq-queue__artist">{e.artist ?? ''}</span>
                </span>
                <span className="hq-queue__dur">
                  {isCurrent ? (
                    <Icon name="volume" size={14} className="hq-accent" />
                  ) : (
                    formatDuration(e.durationMs)
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
