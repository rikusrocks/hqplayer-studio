import type { RemoteDevice, RemoteSettings as RemoteSettingsDto } from '@hqps/contracts';
import {
  ErrorBlock,
  Icon,
  LoadingBlock,
  Spinner,
  formatDate,
  useAsync,
  useDialogs,
  useI18n,
  useStudio,
  useToasts,
} from '@hqps/ui';
import { useEffect, useState } from 'react';
import { QrCode } from './QrCode';

/** Settings → 网页遥控: LAN listener, pairing codes (with QR) and paired devices. */
export function RemoteSettings() {
  const { t } = useI18n();
  const { client, run, remoteVersion, server } = useStudio();
  const { confirm } = useDialogs();
  const toasts = useToasts();
  const settings = useAsync(() => client.remote.settings(), [client, remoteVersion]);
  const [busy, setBusy] = useState(false);
  const localUrl = `${window.location.origin}/remote/`;
  const s = settings.data;
  const usable = s?.interfaces.filter((i) => i.usable) ?? [];
  const [choice, setChoice] = useState<string | null>(null);
  const selected = choice ?? s?.interfaceName ?? usable[0]?.name ?? null;

  if (server && !server.trustedClient) {
    return <p className="hint">{t('settings.remoteHint')}</p>;
  }
  if (settings.error) return <ErrorBlock error={settings.error} onRetry={settings.reload} />;
  if (!s) return <LoadingBlock />;

  const apply = async (enabled: boolean, interfaceName = selected) => {
    if (enabled) {
      const iface = s.interfaces.find((i) => i.name === interfaceName);
      if (!s.enabled) {
        const ok = await confirm({
          title: t('settings.remoteConfirmTitle'),
          message: t('settings.remoteConfirmMessage', {
            address: iface?.address ?? '—',
            port: s.port,
          }),
          confirmLabel: t('settings.remoteConfirm'),
        });
        if (!ok) return;
      }
    }
    setBusy(true);
    const res = await run(() =>
      client.remote.setSettings(
        enabled ? { enabled, ...(interfaceName ? { interfaceName } : {}) } : { enabled },
      ),
    );
    setBusy(false);
    if (res) {
      settings.setData(res);
      toasts.push(
        res.state === 'error' ? 'warning' : 'success',
        enabled ? t('settings.remoteOn') : t('settings.remoteOff'),
      );
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toasts.push('success', t('settings.remoteCopied'));
    } catch {
      // clipboard unavailable: the address is selectable text anyway
    }
  };

  return (
    <div className="settings-stack">
      <StatusBanner settings={s} />

      <div className="settings-block">
        <h3>{t('settings.remoteLan')}</h3>
        <label className="engine-option engine-control">
          <input
            type="checkbox"
            role="switch"
            checked={s.enabled}
            disabled={busy || (!s.enabled && usable.length === 0)}
            onChange={(e) => void apply(e.target.checked)}
          />
          <span>
            <strong>{t('settings.remoteLanSwitch')}</strong>
            <span className="hint">{t('settings.remoteLanSwitchHint')}</span>
          </span>
        </label>
        {s.interfaces.length === 0 || usable.length === 0 ? (
          <p className="hint">{t('settings.remoteNoNetwork')}</p>
        ) : null}
        <div className="kv">
          <span>{t('settings.remoteNetwork')}</span>
          <select
            className="hq-select"
            value={selected ?? ''}
            disabled={busy || usable.length === 0}
            onChange={(e) => {
              setChoice(e.target.value);
              if (s.enabled) void apply(true, e.target.value);
            }}
          >
            {s.interfaces.map((i) => (
              <option key={`${i.name}|${i.address}`} value={i.name} disabled={!i.usable}>
                {t(i.usable ? 'settings.remoteNetworkOption' : 'settings.remoteNetworkUnusable', {
                  name: i.name,
                  address: i.address,
                })}
              </option>
            ))}
          </select>
          <span>{t('settings.remotePort')}</span>
          <strong className="hq-mono">{s.port}</strong>
          {s.urls.length > 0 && (
            <>
              <span>{t('settings.remoteLanUrls')}</span>
              <span className="kv__list">
                {s.urls.map((u) => (
                  <span key={u} className="kv__row">
                    <code className="hq-mono remote-url">{u}</code>
                    <button
                      type="button"
                      className="hq-btn hq-btn--sm"
                      onClick={() => void copy(u)}
                    >
                      <Icon name="copy" size={14} />
                      {t('settings.remoteCopy')}
                    </button>
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
        <p className="hint">{t('settings.remoteFirewall')}</p>
        <p className="hint">{t('settings.remoteHttpNote')}</p>
      </div>

      <PairingBlock settings={s} onChanged={settings.setData} />

      <DevicesBlock devices={s.devices} />

      <div className="kv">
        <span>{t('settings.remoteLocalUrl')}</span>
        <span className="kv__row">
          <code className="hq-mono">{localUrl}</code>
          <a className="hq-btn hq-btn--sm" href={localUrl} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} />
            {t('settings.remoteOpen')}
          </a>
        </span>
      </div>
      <p className="hint">{t('remote.noAudio')}</p>
    </div>
  );
}

function StatusBanner({ settings: s }: { settings: RemoteSettingsDto }) {
  const { t } = useI18n();
  if (s.state === 'listening') {
    return (
      <div className="hq-banner hq-banner--info">
        <Icon name="remote" size={16} />
        <div className="hq-banner__body">
          <strong>{t('settings.remoteListening')}</strong>
          <span className="hq-mono">{s.urls.join('  ')}</span>
        </div>
      </div>
    );
  }
  if (s.state === 'error' && s.error) {
    return (
      <div className="hq-banner hq-banner--warn" role="alert">
        <Icon name="warning" size={16} />
        <div className="hq-banner__body">
          <strong>{t('settings.remoteErrorTitle')}</strong>
          <span>{t(`settings.remoteError.${s.error}`, { port: s.port })}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="hq-banner hq-banner--muted">
      <Icon name="remote" size={16} />
      <div className="hq-banner__body">
        <strong>{t('settings.remoteDisabled')}</strong>
        <span>{t('settings.remoteHint')}</span>
      </div>
    </div>
  );
}

/** Ticks once a second while a code is shown (countdown). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function PairingBlock({
  settings: s,
  onChanged,
}: {
  settings: RemoteSettingsDto;
  onChanged: (next: RemoteSettingsDto) => void;
}) {
  const { t } = useI18n();
  const { client, run } = useStudio();
  const [busy, setBusy] = useState(false);
  const pairing = s.pairing;
  const now = useNow(pairing !== null);
  const left = pairing ? Math.max(0, pairing.expiresAt - now) : 0;
  const expired = pairing !== null && left === 0;

  const create = async () => {
    setBusy(true);
    const code = await run(() => client.remote.createPairingCode());
    setBusy(false);
    if (code) onChanged({ ...s, pairing: code });
  };
  const cancel = async () => {
    const ok = await run(() => client.remote.cancelPairingCode());
    if (ok) onChanged({ ...s, pairing: null });
  };

  const listening = s.state === 'listening';
  const mmss = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  return (
    <div className="settings-block">
      <div className="settings-block__head">
        <h3>{t('settings.remotePairTitle')}</h3>
        {listening && (
          <button
            type="button"
            className="hq-btn hq-btn--sm hq-btn--primary"
            onClick={() => void create()}
            disabled={busy}
          >
            {busy ? <Spinner size={14} /> : <Icon name="plus" size={14} />}
            {pairing && !expired ? t('settings.remotePairNew') : t('settings.remotePairCreate')}
          </button>
        )}
      </div>
      {!listening ? (
        <p className="hint">{t('settings.remotePairNeedsLan')}</p>
      ) : pairing && !expired ? (
        <div className="pairing">
          <QrCode text={pairing.urls[0] ?? ''} label={t('settings.remotePairQr')} />
          <div className="pairing__body">
            <div className="pairing__code hq-mono" aria-label={t('pair.code')}>
              {pairing.code.slice(0, 3)} {pairing.code.slice(3)}
            </div>
            <div className="hq-muted">{t('settings.remotePairExpires', { time: mmss })}</div>
            <code className="hq-mono remote-url">{s.urls[0]}</code>
            <p className="hint">{t('settings.remotePairHint')}</p>
            <div className="button-row">
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => void cancel()}>
                <Icon name="close" size={14} />
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="hint">{t('settings.remotePairHint')}</p>
      )}
    </div>
  );
}

function DevicesBlock({ devices }: { devices: RemoteDevice[] }) {
  const { t, locale } = useI18n();
  const { client, run } = useStudio();
  const { confirm } = useDialogs();
  const revoke = async (d: RemoteDevice) => {
    const ok = await confirm({
      title: t('settings.remoteRevokeTitle', { name: d.name }),
      message: t('settings.remoteRevokeMessage'),
      confirmLabel: t('settings.remoteRevoke'),
      danger: true,
    });
    if (!ok) return;
    await run(() => client.remote.revokeDevice(d.id), {
      success: t('settings.remoteRevoked', { name: d.name }),
    });
  };
  return (
    <div className="settings-block">
      <h3>{t('settings.remoteDevices')}</h3>
      {devices.length === 0 ? (
        <p className="hint">{t('settings.remoteNoDevices')}</p>
      ) : (
        <ul className="root-list">
          {devices.map((d) => (
            <li key={d.id} className="root-row">
              <Icon name="remote" size={20} />
              <div className="root-row__body">
                <div className="root-row__name">
                  {d.name}
                  {d.connected && (
                    <span className="hq-badge hq-badge--ok">{t('settings.remoteConnected')}</span>
                  )}
                </div>
                <div className="root-row__meta">
                  {t('settings.remoteDeviceLine', {
                    paired: formatDate(d.createdAt, locale),
                    seen: formatDate(d.lastSeenAt, locale),
                  })}
                  {d.lastAddress && <span className="hq-mono"> · {d.lastAddress}</span>}
                </div>
              </div>
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => void revoke(d)}>
                <Icon name="trash" size={14} />
                {t('settings.remoteRevoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
