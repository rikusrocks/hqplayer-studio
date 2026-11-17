import type { BackupInfo, BackupState, LogInfo, SoakStatus } from '@hqps/contracts';
import {
  ErrorBlock,
  Icon,
  LoadingBlock,
  Spinner,
  formatDate,
  formatDuration,
  formatNumber,
  useAsync,
  useDialogs,
  useI18n,
  useStudio,
  useToasts,
  type MessageKey,
} from '@hqps/ui';
import { useEffect, useState } from 'react';
import { getShell } from '../shell';
import { BlockHead } from './SettingsSections';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function OpenFolderButton({ which, label }: { which: 'logs' | 'backups' | 'soak'; label: string }) {
  const shell = getShell();
  const toasts = useToasts();
  const { t } = useI18n();
  if (!shell?.openFolder) return null;
  return (
    <button
      type="button"
      className="hq-btn"
      onClick={() =>
        void shell.openFolder(which).then((err) => {
          if (err) toasts.push('error', t('maint.openFolderFailed', { error: err }));
        })
      }
    >
      <Icon name="folder" size={14} />
      {label}
    </button>
  );
}

// ------------------------------------------------------------------ Settings → 常规 → 数据备份

export function BackupSettings() {
  const { t, locale } = useI18n();
  const { client, run, server } = useStudio();
  const { confirm } = useDialogs();
  const toasts = useToasts();
  const loaded = useAsync(() => client.maintenance.backups(), [client]);
  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState(false);
  const shell = getShell();
  const current = state ?? loaded.data ?? null;
  if (server && !server.trustedClient) return null;
  if (!current) return loaded.error ? <ErrorBlock error={loaded.error} /> : <LoadingBlock />;
  if (!current.available) return null;

  const kindLabel = (b: BackupInfo) => t(`maint.backup.kind.${b.kind}` as MessageKey);

  const backupNow = async () => {
    setBusy(true);
    const next = await run(() => client.maintenance.backupNow(), {
      success: t('maint.backup.done'),
    });
    setBusy(false);
    if (next) setState(next);
  };

  const restore = async (b: BackupInfo) => {
    const ok = await confirm({
      title: t('maint.backup.restoreTitle'),
      message: t('maint.backup.restoreConfirm', {
        when: formatDate(b.createdAt, locale),
        kind: kindLabel(b),
      }),
      confirmLabel: t('maint.backup.restoreAndRestart'),
      danger: true,
    });
    if (!ok) return;
    const next = await run(() => client.maintenance.restore(b.id));
    if (!next) return;
    setState(next);
    if (shell) shell.relaunch();
    else toasts.push('info', t('maint.backup.restartManually'));
  };

  const cancel = async () => {
    const next = await run(() => client.maintenance.cancelRestore());
    if (next) setState(next);
  };

  const pending = current.pendingRestore;
  const last = current.lastRestore;
  return (
    <div className="settings-block">
      <BlockHead title={t('maint.backup.title')} layer="studio" />
      <div className="kv">
        <span>{t('maint.backup.schema')}</span>
        <strong>
          {current.schemaVersion} / {current.supportedSchemaVersion}
        </strong>
        <span>{t('maint.backup.lastDaily')}</span>
        <strong>{current.lastDailyAt ? formatDate(current.lastDailyAt, locale) : '—'}</strong>
        {current.lastError && (
          <>
            <span>{t('maint.backup.lastError')}</span>
            <span className="hq-mono">{current.lastError}</span>
          </>
        )}
        {last && (
          <>
            <span>{t('maint.backup.lastRestore')}</span>
            <span>
              {last.ok
                ? t('maint.backup.lastRestoreOk', { when: formatDate(last.at, locale) })
                : t('maint.backup.lastRestoreFailed', {
                    when: formatDate(last.at, locale),
                    error: last.error ?? '',
                  })}
            </span>
          </>
        )}
      </div>
      {pending && (
        <div className="maint-notice maint-notice--warn" role="status">
          <Icon name="warning" size={16} />
          <span>{t('maint.backup.pending')}</span>
          <div className="button-row">
            {shell && (
              <button
                type="button"
                className="hq-btn hq-btn--primary"
                onClick={() => shell.relaunch()}
              >
                {t('maint.backup.restartNow')}
              </button>
            )}
            <button type="button" className="hq-btn" onClick={() => void cancel()}>
              {t('maint.backup.cancelRestore')}
            </button>
          </div>
        </div>
      )}
      <div className="button-row">
        <button
          type="button"
          className="hq-btn"
          onClick={() => void backupNow()}
          disabled={busy || current.running}
        >
          {busy || current.running ? <Spinner size={14} /> : <Icon name="copy" size={14} />}
          {t('maint.backup.now')}
        </button>
        <OpenFolderButton which="backups" label={t('maint.backup.openFolder')} />
      </div>
      {current.backups.length === 0 ? (
        <p className="hint">{t('maint.backup.none')}</p>
      ) : (
        <table className="hq-table maint-table">
          <thead>
            <tr>
              <th>{t('maint.backup.col.when')}</th>
              <th>{t('maint.backup.col.kind')}</th>
              <th>{t('maint.backup.col.version')}</th>
              <th>{t('maint.backup.col.size')}</th>
              <th aria-label={t('maint.backup.restore')} />
            </tr>
          </thead>
          <tbody>
            {current.backups.map((b) => (
              <tr key={b.id}>
                <td>{formatDate(b.createdAt, locale)}</td>
                <td>{kindLabel(b)}</td>
                <td>
                  {t('maint.backup.versionCell', { app: b.appVersion, schema: b.schemaVersion })}
                </td>
                <td>{formatBytes(b.sizeBytes)}</td>
                <td>
                  <button
                    type="button"
                    className="hq-btn hq-btn--sm"
                    disabled={!b.restorable || pending === b.id}
                    title={b.restorable ? undefined : t('maint.backup.notRestorable')}
                    onClick={() => void restore(b)}
                  >
                    {t('maint.backup.restore')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Settings → 诊断 → 日志

export function LogsCard() {
  const { t, locale } = useI18n();
  const { client, server } = useStudio();
  const loaded = useAsync(() => client.maintenance.logs(), [client]);
  if (server && !server.trustedClient) return null;
  const info: LogInfo | null = loaded.data ?? null;
  return (
    <div className="settings-block">
      <h3 title={t('maint.logs.hint')}>{t('maint.logs.title')}</h3>
      {!info ? (
        loaded.error ? (
          <ErrorBlock error={loaded.error} />
        ) : (
          <LoadingBlock />
        )
      ) : (
        <>
          {info.previousSessionUnclean && (
            <div className="maint-notice maint-notice--warn" role="status">
              <Icon name="warning" size={16} />
              <span>
                {t('maint.logs.unclean', {
                  when: formatDate(Date.parse(info.previousSessionUnclean.lastAliveAt), locale),
                })}
              </span>
            </div>
          )}
          <div className="kv">
            <span>{t('maint.logs.since')}</span>
            <strong>{formatDate(Date.parse(info.since), locale)}</strong>
            <span>{t('maint.logs.counts')}</span>
            <strong>
              {t('maint.logs.countsValue', {
                warn: formatNumber(info.counts.warn, locale),
                error: formatNumber(info.counts.error, locale),
              })}
            </strong>
            <span>{t('maint.logs.crashes')}</span>
            <strong>{formatNumber(info.crashReports.length, locale)}</strong>
          </div>
          {info.crashReports.length > 0 && (
            <ul className="maint-list">
              {info.crashReports.slice(0, 5).map((c) => (
                <li key={c.name}>
                  <strong>{formatDate(Date.parse(c.at), locale)}</strong> ·{' '}
                  {t(`maint.logs.crashKind.${c.kind}` as MessageKey, { kind: c.kind })}
                  {c.summary && <span className="hq-mono"> — {c.summary}</span>}
                </li>
              ))}
            </ul>
          )}
          {!info.enabled && <p className="hint">{t('maint.logs.disabled')}</p>}
        </>
      )}
      <div className="button-row">
        <OpenFolderButton which="logs" label={t('maint.logs.openFolder')} />
        <button type="button" className="hq-btn" onClick={() => loaded.reload()}>
          <Icon name="refresh" size={14} />
          {t('maint.refresh')}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Settings → 诊断 → 长时间播放测试

const DURATIONS: Array<number | null> = [null, 2, 4, 8, 12, 24];

export function SoakTestCard() {
  const { t, locale } = useI18n();
  const { client, run, server, status } = useStudio();
  const [soak, setSoak] = useState<SoakStatus | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const trusted = !server || server.trustedClient;

  useEffect(() => {
    if (!trusted) return;
    let alive = true;
    const load = () =>
      client.maintenance
        .soak()
        .then((s) => alive && setSoak(s))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, trusted]);

  if (!trusted) return null;

  const start = async () => {
    setBusy(true);
    const next = await run(() => client.maintenance.startSoak(hours));
    setBusy(false);
    if (next) setSoak(next);
  };
  const stop = async () => {
    setBusy(true);
    const next = await run(() => client.maintenance.stopSoak(), {
      success: t('maint.soak.saved'),
    });
    setBusy(false);
    if (next) setSoak(next);
  };

  const live = status.connection === 'connected';
  const dur = (ms: number) => formatDuration(ms);
  return (
    <div className="settings-block">
      <h3 title={t('maint.soak.hint')}>{t('maint.soak.title')}</h3>
      {soak?.running ? (
        <>
          <div className="kv">
            <span>{t('maint.soak.elapsed')}</span>
            <strong>
              {dur(soak.elapsedMs)}
              {soak.stopAt
                ? ` · ${t('maint.soak.until', { when: formatDate(soak.stopAt, locale) })}`
                : ''}
            </strong>
            <span>{t('maint.soak.playing')}</span>
            <strong>{dur(soak.playingMs)}</strong>
            <span>{t('maint.soak.scanOverlap')}</span>
            <strong>{dur(soak.playingWhileScanningMs)}</strong>
            <span>{t('maint.soak.statusUpdates')}</span>
            <strong>
              {formatNumber(soak.statusUpdates, locale)}
              {soak.maxStatusIntervalMs > 0
                ? ` · ${t('maint.soak.maxInterval', { s: (soak.maxStatusIntervalMs / 1000).toFixed(1) })}`
                : ''}
            </strong>
            <span>{t('maint.soak.warnings')}</span>
            <strong>
              {t('maint.soak.warningsValue', {
                n: soak.warnings,
                studio: soak.warningsWithStudioActivity,
              })}
            </strong>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="hq-btn hq-btn--primary"
              onClick={() => void stop()}
              disabled={busy}
            >
              {busy ? <Spinner size={14} /> : <Icon name="stop" size={14} />}
              {t('maint.soak.stop')}
            </button>
          </div>
        </>
      ) : (
        <>
          {!live && <p className="hint">{t('maint.soak.notConnected')}</p>}
          <div className="form-grid">
            <label className="hq-field">
              <span className="hq-field__label">{t('maint.soak.duration')}</span>
              <select
                className="hq-select"
                value={hours === null ? '' : String(hours)}
                onChange={(e) => setHours(e.target.value ? Number(e.target.value) : null)}
              >
                {DURATIONS.map((h) => (
                  <option key={h ?? 'open'} value={h === null ? '' : String(h)}>
                    {h === null ? t('maint.soak.untilStopped') : t('maint.soak.hours', { n: h })}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="hq-btn hq-btn--primary"
              onClick={() => void start()}
              disabled={busy}
            >
              {busy ? <Spinner size={14} /> : <Icon name="play" size={14} />}
              {t('maint.soak.start')}
            </button>
            <OpenFolderButton which="soak" label={t('maint.soak.openFolder')} />
          </div>
        </>
      )}
      {soak && !soak.running && soak.endedAt && (
        <div
          className={`maint-notice ${soak.verdict === 'clean' ? 'maint-notice--ok' : 'maint-notice--warn'}`}
          role="status"
        >
          <Icon name={soak.verdict === 'clean' ? 'check' : 'warning'} size={16} />
          <span>
            {t(`maint.soak.verdict.${soak.verdict ?? 'clean'}` as MessageKey, {
              hours: (soak.elapsedMs / 3600_000).toFixed(1),
              n: soak.warnings,
              studio: soak.warningsWithStudioActivity,
            })}{' '}
            {soak.reportFile && t('maint.soak.reportFile', { file: soak.reportFile })}
          </span>
        </div>
      )}
      {soak && soak.recent.length > 0 && (
        <details className="maint-details">
          <summary>{t('maint.soak.recent', { n: soak.recent.length })}</summary>
          <ul className="maint-list">
            {soak.recent.map((i) => (
              <li key={`${i.at}-${i.kind}`}>
                <strong>{formatDate(i.at, locale)}</strong> · {i.severity} · {i.detail}
                {i.studioActivity && (
                  <span className="layer-tag layer-tag--control">
                    {t('maint.soak.studioActive')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
