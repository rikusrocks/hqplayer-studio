import {
  Icon,
  Spinner,
  formatDate,
  useDialogs,
  useI18n,
  useStudio,
  useToasts,
  type MessageKey,
} from '@hqps/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  getShell,
  type HqpSettingsBackup,
  type HqpSettingsBackupState,
  type RestoreReport,
} from '../shell';
import { BlockHead } from './SettingsSections';

/** Copies shown in the card (the folder has all of them). */
const SHOWN = 8;

/** HQPlayer's settings-file copies, refreshed every minute and when HQPlayer (re)connects. */
export function useHqpSettingsBackups() {
  const api = getShell()?.hqplayerSettings;
  const { status } = useStudio();
  const [state, setState] = useState<HqpSettingsBackupState | null>(null);
  const reload = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.get();
      if (next) setState(next);
    } catch {
      // older desktop app or a failed read: the card simply stays as it was
    }
  }, [api]);
  const connected = status.connection === 'connected';
  useEffect(() => {
    if (!api) return;
    void reload();
    // main checks a few seconds after HQPlayer connects; look a little later
    const soon = setTimeout(() => void reload(), 6_000);
    const timer = setInterval(() => void reload(), 60_000);
    return () => {
      clearTimeout(soon);
      clearInterval(timer);
    };
  }, [api, reload, connected]);
  return { api, state, setState, reload };
}

/** Confirm, restore, and say what happened. Returns the report (null when cancelled). */
function useRestore() {
  const { t, locale } = useI18n();
  const { confirm } = useDialogs();
  const toasts = useToasts();
  return async (
    b: HqpSettingsBackup,
    api: NonNullable<ReturnType<typeof useHqpSettingsBackups>['api']>,
  ): Promise<RestoreReport | null> => {
    const ok = await confirm({
      title: t('hqpSet.restoreTitle'),
      message: t('hqpSet.restoreConfirm', { when: formatDate(b.at, locale) }),
      confirmLabel: t('hqpSet.restore'),
      danger: true,
    });
    if (!ok) return null;
    try {
      const report = await api.restore(b.id);
      if (!report) return null;
      if (report.ok) toasts.push('success', t('hqpSet.restored'));
      else toasts.push('error', t(`hqpSet.error.${report.error ?? 'write_failed'}` as MessageKey));
      return report;
    } catch (err) {
      toasts.push('error', (err as Error).message);
      return null;
    }
  };
}

/**
 * Shown above every page when HQPlayer's settings file shrank to (near) defaults: offers to put
 * the last full copy back.
 */
export function HqpResetBanner() {
  const { t, locale } = useI18n();
  const { api, state, setState, reload } = useHqpSettingsBackups();
  const restore = useRestore();
  const [busy, setBusy] = useState(false);
  const warning = state?.resetWarning;
  if (!api || !warning) return null;
  const good = state.backups.find((b) => b.id === warning.goodId);
  if (!good) return null;
  return (
    <div className="hq-banner hq-banner--warn hqp-reset-banner" role="alert">
      <Icon name="warning" size={18} />
      <div className="hq-banner__body">
        <strong>{t('hqpSet.resetTitle')}</strong>
        <span>{t('hqpSet.resetBody', { when: formatDate(good.at, locale) })}</span>
      </div>
      <button
        type="button"
        className="hq-btn hq-btn--sm hq-btn--primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void restore(good, api)
            .then(() => reload())
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}
        {t('hqpSet.restore')}
      </button>
      <button
        type="button"
        className="hq-btn hq-btn--sm hq-btn--ghost"
        disabled={busy}
        onClick={() => void api.dismiss().then((s) => s && setState(s))}
      >
        {t('hqpSet.notNow')}
      </button>
    </div>
  );
}

/** Settings → HQPlayer: the copies of HQPlayer's settings file, and Restore. */
export function HqpSettingsBackupCard() {
  const { t, locale } = useI18n();
  const toasts = useToasts();
  const { api, state, setState, reload } = useHqpSettingsBackups();
  const restore = useRestore();
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  if (!api || !state?.supported) return null;

  const backupNow = async () => {
    setBusy('now');
    try {
      const next = await api.backupNow();
      if (next) setState(next);
      toasts.push('success', t(next?.found ? 'hqpSet.saved' : 'hqpSet.notFound'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-block">
      <BlockHead
        title={t('hqpSet.title')}
        layer="studio"
        aside={
          <span className="hqp-set__actions">
            <button
              type="button"
              className="hq-btn hq-btn--sm"
              disabled={busy !== null}
              onClick={() => void backupNow()}
            >
              {busy === 'now' ? <Spinner size={12} /> : <Icon name="copy" size={14} />}
              {t('hqpSet.backupNow')}
            </button>
            <button
              type="button"
              className="hq-btn hq-btn--sm hq-btn--ghost"
              onClick={() => void getShell()?.openFolder('hqp-settings')}
            >
              <Icon name="folder" size={14} />
              {t('hqpSet.openFolder')}
            </button>
          </span>
        }
      />
      <p className="hint">{t('hqpSet.hint')}</p>
      <div className="kv">
        <span>{t('hqpSet.file')}</span>
        <span className="kv__list">
          <span className="hq-mono">{state.settingsPath}</span>
          <span className="hint">{state.found ? t('hqpSet.found') : t('hqpSet.notFound')}</span>
        </span>
        <span>{t('hqpSet.lastCheck')}</span>
        <strong>{state.lastCheckAt ? formatDate(state.lastCheckAt, locale) : '—'}</strong>
      </div>
      {state.backups.length === 0 ? (
        <p className="hint">{t('hqpSet.none')}</p>
      ) : (
        <ul className="hqp-set__list">
          {state.backups.slice(0, SHOWN).map((b) => (
            <li key={b.id} className={`hqp-set__item${b.suspect ? ' is-suspect' : ''}`}>
              <div className="hqp-set__meta">
                <strong>{formatDate(b.at, locale)}</strong>
                <span className="hint">
                  {t(`hqpSet.reason.${b.reason}` as MessageKey)} ·{' '}
                  {t('hqpSet.size', { kb: (b.size / 1024).toFixed(1), n: b.elements })}
                </span>
                {b.suspect && <span className="hqp-set__tag">{t('hqpSet.looksReset')}</span>}
                {b.pinned && (
                  <span className="hqp-set__tag hqp-set__tag--pin">{t('hqpSet.pinned')}</span>
                )}
              </div>
              <button
                type="button"
                className="hq-icon-btn hq-icon-btn--sm"
                title={t(b.pinned ? 'hqpSet.unpin' : 'hqpSet.pin')}
                aria-label={t(b.pinned ? 'hqpSet.unpin' : 'hqpSet.pin')}
                aria-pressed={b.pinned}
                onClick={() => void api.pin(b.id, !b.pinned).then((s) => s && setState(s))}
              >
                <Icon name="pin" size={14} />
              </button>
              <button
                type="button"
                className="hq-btn hq-btn--sm"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(b.id);
                  setReport(null);
                  void restore(b, api)
                    .then((r) => {
                      if (r) setReport(r);
                      return reload();
                    })
                    .finally(() => setBusy(null));
                }}
              >
                {busy === b.id ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}
                {t('hqpSet.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {report && (
        <div className={`hqp-report${report.ok ? '' : ' hqp-report--warn'}`}>
          <p>
            {report.ok
              ? t('hqpSet.restored')
              : t(`hqpSet.error.${report.error ?? 'write_failed'}` as MessageKey)}
          </p>
          <ul>
            {report.steps.map((s) => (
              <li key={s.id}>
                {s.ok ? '✓' : '✗'} {t(`hqpSet.step.${s.id}` as MessageKey)}
                {s.detail && !s.ok ? ` — ${s.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
