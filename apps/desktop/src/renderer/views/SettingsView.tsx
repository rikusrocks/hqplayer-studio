import {
  ENGINE_CAPABILITY_KEYS,
  canUse,
  type AdapterKind,
  type EngineQueue,
  type EngineSettings,
  type LibraryRoot,
  type MockControlRequest,
  type ScanJob,
} from '@hqps/contracts';
import {
  CapabilityStatusBadge,
  ConnectionBadge,
  EmptyState,
  ErrorBlock,
  FormatBadge,
  Icon,
  LOCALES,
  LoadingBlock,
  Spinner,
  formatDate,
  formatDuration,
  formatNumber,
  useAsync,
  useI18n,
  useNowPlaying,
  useStudio,
  useTheme,
  type IconName,
  type Locale,
  type MessageKey,
  type Theme,
} from '@hqps/ui';
import { useState } from 'react';
import { getShell } from '../shell';
import { ViewHeader } from './common';

const SECTIONS: Array<{ id: string; label: MessageKey; icon: IconName }> = [
  { id: 'general', label: 'settings.general', icon: 'settings' },
  { id: 'library', label: 'settings.library', icon: 'library' },
  { id: 'playback', label: 'settings.playback', icon: 'play' },
  { id: 'dsp', label: 'settings.dsp', icon: 'wave' },
  { id: 'remote', label: 'settings.remote', icon: 'remote' },
  { id: 'diagnostics', label: 'settings.diagnostics', icon: 'activity' },
];

export function SettingsView({ section }: { section: string }) {
  const { t } = useI18n();
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  return (
    <div className="view settings">
      <ViewHeader title={t('nav.settings')} />
      <div className="settings__layout">
        <nav className="settings__nav" aria-label={t('nav.settings')}>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#/settings/${s.id}`}
              className={`settings__navlink${s.id === current.id ? ' is-active' : ''}`}
              aria-current={s.id === current.id ? 'page' : undefined}
            >
              <Icon name={s.icon} size={16} />
              {t(s.label)}
            </a>
          ))}
        </nav>
        <div className="settings__panel">
          <h2 className="settings__title">{t(current.label)}</h2>
          {current.id === 'general' && <GeneralSettings />}
          {current.id === 'library' && <LibrarySettings />}
          {current.id === 'playback' && <PlaybackSettings />}
          {current.id === 'dsp' && <DspSettings />}
          {current.id === 'remote' && <RemoteSettings />}
          {current.id === 'diagnostics' && <Diagnostics />}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useTheme();
  return (
    <div className="form-grid">
      <label className="hq-field">
        <span className="hq-field__label">{t('settings.language')}</span>
        <select
          className="hq-select"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {LOCALES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="hq-field">
        <span className="hq-field__label">{t('settings.theme')}</span>
        <select
          className="hq-select"
          value={theme}
          onChange={(e) => setTheme(e.target.value as Theme)}
        >
          <option value="dark">{t('settings.theme.dark')}</option>
          <option value="light">{t('settings.theme.light')}</option>
        </select>
      </label>
      <p className="hint">{t('app.disclaimer')}</p>
    </div>
  );
}

function scanJobLine(job: ScanJob, t: ReturnType<typeof useI18n>['t']): string {
  return t('settings.scanJob', {
    seen: job.filesSeen,
    parsed: job.filesParsed,
    added: job.added,
    updated: job.updated,
    unavailable: job.markedUnavailable,
    errors: job.errors,
  });
}

function LibrarySettings() {
  const { t, locale } = useI18n();
  const { client, run, libraryVersion, scanJobs, server } = useStudio();
  const shell = getShell();
  const [path, setPath] = useState('');
  const runningCount = scanJobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
  // Re-fetch roots when the library changes or a scan finishes.
  const roots = useAsync(() => client.library.roots(), [client, libraryVersion, runningCount]);
  const trusted = server?.trustedClient ?? false;

  const addRoot = async () => {
    const p = path.trim();
    if (!p) return;
    const root = await run(() => client.library.addRoot(p), { success: t('settings.rootAdded') });
    if (root) {
      setPath('');
      roots.reload();
      await run(() => client.library.scan(root.id), { success: t('settings.scanStarted') });
    }
  };

  const pick = async () => {
    const picked = await shell?.pickFolder();
    if (picked) setPath(picked);
  };

  const scan = (rootId?: string) =>
    run(() => client.library.scan(rootId), { success: t('settings.scanStarted') });

  const jobsByRoot = new Map<string, ScanJob>();
  for (const j of scanJobs) if (!jobsByRoot.has(j.rootId)) jobsByRoot.set(j.rootId, j);

  return (
    <div className="settings-stack">
      <p className="hint">{t('settings.libraryHint')}</p>

      <div className="settings-block">
        <div className="settings-block__head">
          <h3>{t('settings.roots')}</h3>
          <button
            type="button"
            className="hq-btn hq-btn--sm"
            onClick={() => void scan()}
            disabled={!roots.data?.length}
          >
            <Icon name="refresh" size={14} />
            {t('settings.scanAll')}
          </button>
        </div>
        {roots.error ? (
          <ErrorBlock error={roots.error} onRetry={roots.reload} />
        ) : !roots.data ? (
          <LoadingBlock />
        ) : roots.data.length === 0 ? (
          <EmptyState icon="folder" title={t('settings.noRoots')} />
        ) : (
          <ul className="root-list">
            {roots.data.map((root) => (
              <RootRow
                key={root.id}
                root={root}
                job={jobsByRoot.get(root.id)}
                locale={locale}
                onScan={() => void scan(root.id)}
                jobLine={(j) => scanJobLine(j, t)}
              />
            ))}
          </ul>
        )}
      </div>

      {trusted && (
        <form
          className="settings-block add-root"
          onSubmit={(e) => {
            e.preventDefault();
            void addRoot();
          }}
        >
          <h3>{t('settings.addRoot')}</h3>
          <div className="add-root__row">
            <input
              className="hq-input hq-mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t('settings.rootPlaceholder')}
              spellCheck={false}
              aria-label={t('settings.addRoot')}
            />
            {shell && (
              <button type="button" className="hq-btn" onClick={() => void pick()}>
                <Icon name="folder" size={16} />
                {t('settings.pickFolder')}
              </button>
            )}
            <button type="submit" className="hq-btn hq-btn--primary" disabled={!path.trim()}>
              <Icon name="plus" size={16} />
              {t('settings.addRoot')}
            </button>
          </div>
        </form>
      )}
      <p className="hint hq-muted">
        {formatNumber(roots.data?.reduce((n, r) => n + r.trackCount, 0) ?? 0, locale)}{' '}
        {t('home.statsTracks')}
      </p>
    </div>
  );
}

function RootRow({
  root,
  job,
  locale,
  onScan,
  jobLine,
}: {
  root: LibraryRoot;
  job: ScanJob | undefined;
  locale: Locale;
  onScan: () => void;
  jobLine: (j: ScanJob) => string;
}) {
  const { t } = useI18n();
  const running = job && (job.state === 'running' || job.state === 'queued');
  const statusTone = root.status === 'online' ? 'ok' : root.status === 'offline' ? 'danger' : '';
  return (
    <li className="root-row">
      <Icon name={root.kind === 'unc' ? 'plug' : 'folder'} size={20} />
      <div className="root-row__body">
        <div className="root-row__name">
          {root.name}
          <span className="hq-badge">{t(`settings.rootKind.${root.kind}`)}</span>
          <span className={`hq-badge${statusTone ? ` hq-badge--${statusTone}` : ''}`}>
            {t(`settings.rootStatus.${root.status}`)}
          </span>
        </div>
        <div className="root-row__path hq-mono">{root.path}</div>
        <div className="root-row__meta">
          {t('common.tracksCount', { count: formatNumber(root.trackCount, locale) })} ·{' '}
          {root.lastScannedAt
            ? t('settings.lastScanned', { date: formatDate(root.lastScannedAt, locale) })
            : t('settings.neverScanned')}
        </div>
        {root.lastError && <div className="root-row__error">{root.lastError}</div>}
        {job && (
          <div className={`root-row__job${running ? ' is-running' : ''}`}>
            {running && <Spinner size={12} />}
            <strong>{t(`scan.state.${job.state}`)}</strong>
            <span>{jobLine(job)}</span>
            {job.currentFolder && running && (
              <span className="hq-mono hq-muted">{job.currentFolder}</span>
            )}
            {job.message && <span className="hq-muted">{job.message}</span>}
          </div>
        )}
      </div>
      <button
        type="button"
        className="hq-btn hq-btn--sm"
        onClick={onScan}
        disabled={running || root.kind === 'fixture'}
      >
        <Icon name="refresh" size={14} />
        {t('settings.scan')}
      </button>
    </li>
  );
}

function PlaybackSettings() {
  const { t } = useI18n();
  const { capabilities } = useStudio();
  if (!capabilities) return <LoadingBlock />;
  return (
    <div className="settings-stack">
      <EngineModeCard />
      <p className="hint">{t('settings.capabilitiesHint')}</p>
      <div className="kv">
        <span>{t('diag.adapter')}</span>
        <strong>{capabilities.adapter}</strong>
        <span>{t('diag.engine')}</span>
        <strong>
          {capabilities.engine
            ? [
                capabilities.engine.product,
                capabilities.engine.version,
                capabilities.engine.platform,
              ]
                .filter(Boolean)
                .join(' · ')
            : '—'}
        </strong>
      </div>
      <table className="hq-table cap-table">
        <thead>
          <tr>
            <th>{t('settings.capability')}</th>
            <th>{t('settings.status')}</th>
            <th>{t('settings.usable')}</th>
            <th>{t('settings.evidence')}</th>
          </tr>
        </thead>
        <tbody>
          {ENGINE_CAPABILITY_KEYS.map((key) => {
            const entry = capabilities.items[key];
            return (
              <tr key={key}>
                <td>
                  <div>{t(`cap.key.${key}`)}</div>
                  <div className="hq-mono hq-muted">{key}</div>
                </td>
                <td>{entry ? <CapabilityStatusBadge status={entry.status} /> : '—'}</td>
                <td>
                  {entry?.usable ? (
                    <Icon name="check" size={16} className="cap-yes" label={t('common.yes')} />
                  ) : (
                    <span className="hq-muted">{t('common.no')}</span>
                  )}
                </td>
                <td>
                  {entry?.evidence && <div className="hq-mono">{entry.evidence}</div>}
                  {entry?.note && <div className="hq-muted">{entry.note}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DspSettings() {
  const { t } = useI18n();
  const { status } = useStudio();
  const now = useNowPlaying();
  const dsp = status.dsp;
  return (
    <div className="settings-stack">
      <div className="hq-banner hq-banner--info">
        <Icon name="info" size={16} />
        <span>{t('settings.dspHint')}</span>
      </div>
      {dsp || status.output ? (
        <div className="kv">
          <span>{t('settings.signalPath')}</span>
          <span>
            <FormatBadge inputLabel={now.inputLabel} output={status.output} />
          </span>
          <span>{t('settings.dspMode')}</span>
          <strong>{dsp?.mode ?? '—'}</strong>
          <span>{t('settings.dspFilter')}</span>
          <strong>{dsp?.filter ?? '—'}</strong>
          <span>{t('settings.dspShaper')}</span>
          <strong>{dsp?.shaper ?? '—'}</strong>
          <span>{t('settings.dspRate')}</span>
          <strong>
            {dsp?.outputRate
              ? `${formatNumber(dsp.outputRate, 'en')} Hz`
              : (status.output?.label ?? '—')}
          </strong>
        </div>
      ) : (
        <EmptyState icon="wave" title={t('settings.dspUnavailable')} hint={t('cap.native')} />
      )}
    </div>
  );
}

function RemoteSettings() {
  const { t } = useI18n();
  const { server } = useStudio();
  const localUrl = `${window.location.origin}/remote/`;
  return (
    <div className="settings-stack">
      <div className="hq-banner hq-banner--muted">
        <Icon name="remote" size={16} />
        <div className="hq-banner__body">
          <strong>
            {server?.remote.lanEnabled ? t('settings.remoteLanUrls') : t('settings.remoteDisabled')}
          </strong>
          <span>{server?.remote.note ?? t('settings.remoteHint')}</span>
        </div>
      </div>
      <div className="kv">
        <span>{t('settings.remoteLocalUrl')}</span>
        <span className="kv__row">
          <code className="hq-mono">{localUrl}</code>
          <a className="hq-btn hq-btn--sm" href={localUrl} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} />
            {t('settings.remoteOpen')}
          </a>
        </span>
        {server?.remote.lanEnabled && server.remote.urls.length > 0 && (
          <>
            <span>{t('settings.remoteLanUrls')}</span>
            <span className="kv__list">
              {server.remote.urls.map((u) => (
                <code key={u} className="hq-mono">
                  {u}
                </code>
              ))}
            </span>
          </>
        )}
      </div>
      <p className="hint">{t('remote.noAudio')}</p>
    </div>
  );
}

const MOCK_ACTIONS: Array<{
  action: MockControlRequest['action'];
  label: MessageKey;
  icon: IconName;
}> = [
  { action: 'disconnect', label: 'diag.mock.disconnect', icon: 'close' },
  { action: 'reconnect', label: 'diag.mock.reconnect', icon: 'refresh' },
  { action: 'external-change', label: 'diag.mock.externalChange', icon: 'warning' },
  { action: 'fail-next-command', label: 'diag.mock.failNext', icon: 'activity' },
];

function Diagnostics() {
  const { t } = useI18n();
  const { server, capabilities, status, realtime, isMock, client, run } = useStudio();
  const engine = capabilities?.engine;
  return (
    <div className="settings-stack">
      <div className="kv">
        <span>{t('diag.app')}</span>
        <strong>{server?.appVersion ?? '—'}</strong>
        <span>{t('diag.api')}</span>
        <strong>{server?.apiVersion ?? '—'}</strong>
        <span>{t('diag.adapter')}</span>
        <strong>{server?.adapter ?? capabilities?.adapter ?? '—'}</strong>
        <span>{t('diag.engine')}</span>
        <strong>
          {engine
            ? [engine.product, engine.version, engine.platform, engine.engine]
                .filter(Boolean)
                .join(' · ')
            : '—'}
        </strong>
        <span>{t('diag.connection')}</span>
        <span>
          <ConnectionBadge />
        </span>
        <span>{t('diag.realtime')}</span>
        <strong>{t(`realtime.${realtime}`)}</strong>
        <span>{t('diag.client')}</span>
        <strong>
          {server ? (server.trustedClient ? t('diag.trusted') : t('diag.untrusted')) : '—'}
        </strong>
        <span>{t('diag.demo')}</span>
        <strong>{server ? (server.demoMode ? t('common.yes') : t('common.no')) : '—'}</strong>
        <span>{t('diag.lastError')}</span>
        <span className="hq-mono">{status.lastError ?? '—'}</span>
      </div>

      {canUse(capabilities, 'queue.read') && <EngineQueueCard />}

      {isMock && (
        <div className="settings-block">
          <h3>{t('diag.mockControls')}</h3>
          <p className="hint">{t('diag.mockHint')}</p>
          <div className="button-row">
            {MOCK_ACTIONS.map((m) => (
              <button
                key={m.action}
                type="button"
                className="hq-btn"
                onClick={() =>
                  void run(() => client.engine.mockControl(m.action), {
                    success: t('diag.mockDone', { action: t(m.label) }),
                  })
                }
              >
                <Icon name={m.icon} size={14} />
                {t(m.label)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EngineModeCard() {
  const { t } = useI18n();
  const { client, run } = useStudio();
  const loaded = useAsync(() => client.settings.engine(), [client]);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const current = settings ?? loaded.data ?? null;
  const shell = getShell();
  if (!current) return loaded.error ? <ErrorBlock error={loaded.error} /> : <LoadingBlock />;

  const choose = async (adapter: AdapterKind) => {
    const res = await run(() => client.settings.setEngine(adapter), {
      success: t('engine.mode.saved'),
    });
    if (res) setSettings(res);
  };
  const option = (adapter: AdapterKind, label: string, hint?: string) => (
    <label className="engine-option">
      <input
        type="radio"
        name="engine-adapter"
        value={adapter}
        checked={current.preferredAdapter === adapter}
        onChange={() => void choose(adapter)}
      />
      <span>
        <strong>{label}</strong>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
  return (
    <div className="settings-block">
      <h3>{t('engine.mode.title')}</h3>
      <div className="engine-options" role="radiogroup" aria-label={t('engine.mode.title')}>
        {option('mock', t('engine.mode.mock'))}
        {option(
          'live',
          t('engine.mode.live'),
          t('engine.mode.liveHint', {
            host: current.hqplayer.host,
            port: String(current.hqplayer.port),
          }),
        )}
      </div>
      <p className="hint">{t('engine.mode.active', { adapter: current.activeAdapter })}</p>
      {current.source === 'override' && (
        <div className="hq-banner hq-banner--muted">
          <Icon name="info" size={16} />
          <span>{t('engine.mode.override')}</span>
        </div>
      )}
      {current.restartRequired && (
        <div className="hq-banner hq-banner--info">
          <Icon name="refresh" size={16} />
          <span>{shell ? t('engine.mode.restartRequired') : t('engine.mode.restartManual')}</span>
          {shell && (
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => shell.relaunch()}>
              {t('engine.mode.restart')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EngineQueueCard() {
  const { t } = useI18n();
  const { client, run } = useStudio();
  const [queue, setQueue] = useState<EngineQueue | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    const res = await run(() => client.engine.queue());
    setLoading(false);
    if (res) setQueue(res);
  };
  return (
    <div className="settings-block">
      <h3>{t('engine.queue.title')}</h3>
      <p className="hint">{t('engine.queue.hint')}</p>
      <div className="button-row">
        <button type="button" className="hq-btn" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner size={14} /> : <Icon name="refresh" size={14} />}
          {t('engine.queue.load')}
        </button>
        {queue && (
          <span className="hq-muted">
            {t('engine.queue.count', { count: String(queue.entries.length) })}
            {queue.albumMode !== null &&
              ` · ${queue.albumMode ? t('engine.queue.albumMode') : t('engine.queue.playlistMode')}`}
          </span>
        )}
      </div>
      {queue &&
        (queue.entries.length === 0 ? (
          <p className="hint">{t('engine.queue.empty')}</p>
        ) : (
          <table className="hq-table engine-queue">
            <tbody>
              {queue.entries.map((e) => (
                <tr key={e.index}>
                  <td className="hq-mono hq-muted">{e.index + 1}</td>
                  <td>
                    <div>{e.title ?? '—'}</div>
                    <div className="hq-muted">
                      {[e.artist, e.album].filter(Boolean).join(' · ')}
                      {e.studioTrackId && ` · ${t('engine.queue.inLibrary')}`}
                    </div>
                  </td>
                  <td className="hq-mono hq-muted">
                    {e.durationMs !== null ? formatDuration(e.durationMs) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}
