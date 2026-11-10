import { useDialogs } from '../data/dialogs';
import { useCapabilityGate, useStudio } from '../data/StudioProvider';
import { formatDuration } from '../format';
import { useT } from '../i18n/I18nProvider';
import { Icon } from './Icon';
import { Artwork, EmptyState, Spinner } from './basics';

/**
 * Shown when Studio's planned queue and what HQPlayer actually plays disagree.
 * Studio never silently overwrites the engine; the user decides.
 */
export function QueueSyncBanner() {
  const { queue, queueTakeover, pending, serverReachable } = useStudio();
  const gate = useCapabilityGate();
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
  const reason = gate('queue.replace');
  return (
    <div className="hq-banner hq-banner--warn" role="alert">
      <Icon name="warning" size={18} />
      <div className="hq-banner__body">
        <strong>{t('queue.outOfSync')}</strong>
        <span>{queue.sync.reason ?? t('queue.outOfSyncHint')}</span>
      </div>
      <button
        type="button"
        className="hq-btn hq-btn--sm"
        onClick={() => void queueTakeover()}
        disabled={!!reason || pending.has('takeover')}
        title={reason ?? t('queue.takeoverHint')}
      >
        {pending.has('takeover') ? <Spinner size={14} /> : <Icon name="refresh" size={14} />}
        {t('queue.takeover')}
      </button>
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
    return (
      <div className="hq-queue">
        <QueueSyncBanner />
        <EmptyState icon="queue" title={t('queue.empty')} hint={t('queue.emptyHint')} />
      </div>
    );
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
                onClick={() => void queueJump(index)}
                disabled={!!jumpReason || isCurrent}
                title={jumpReason ?? t('queue.jump')}
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
