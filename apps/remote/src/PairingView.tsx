import { StudioApiError, createStudioClient } from '@hqps/api-client';
import { normalizePairingCode, PAIRING_CODE_LENGTH } from '@hqps/contracts';
import { Icon, Spinner, hasMessage, useT } from '@hqps/ui';
import { useEffect, useRef, useState } from 'react';

/** A friendly default name for the device list on the computer. */
export function guessDeviceName(ua = navigator.userAgent): string {
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  // iPadOS Safari reports itself as a Mac; a touch screen gives it away.
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
}

function isIos(): boolean {
  return (
    /iPhone|iPad/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

function describePairError(err: unknown, t: ReturnType<typeof useT>): string {
  if (err instanceof StudioApiError) {
    if (err.code === 'network_error') return t('pair.error.network');
    const details = (err.details ?? {}) as {
      reason?: string;
      attemptsLeft?: number;
      retryAfterSec?: number;
    };
    if (err.code === 'rate_limited') {
      return t('pair.error.rate_limited', { seconds: details.retryAfterSec ?? 60 });
    }
    const key = `pair.error.${details.reason ?? ''}`;
    if (details.reason && hasMessage(key)) return t(key, { count: details.attemptsLeft ?? 0 });
    return t('errors.generic', { message: err.message });
  }
  return t('errors.generic', { message: err instanceof Error ? err.message : String(err) });
}

export function CheckingView() {
  const t = useT();
  return (
    <div className="rm-pair">
      <div className="rm-pair__card rm-pair__card--center" role="status">
        <Spinner size={24} />
        <span>{t('pair.checking')}</span>
      </div>
    </div>
  );
}

export function PairingView({
  initialCode,
  revoked,
  offline,
  onPaired,
}: {
  initialCode: string;
  revoked: boolean;
  offline: boolean;
  onPaired: (token: string, device: { id: string; name: string }) => void;
}) {
  const t = useT();
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(offline ? t('pair.error.network') : null);
  const codeRef = useRef<HTMLInputElement>(null);
  const digits = normalizePairingCode(code);
  const valid = /^\d+$/.test(digits) && digits.length === PAIRING_CODE_LENGTH && name.trim() !== '';

  useEffect(() => {
    if (!initialCode) codeRef.current?.focus();
  }, [initialCode]);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createStudioClient().remote.pair({ code: digits, deviceName: name.trim() });
      onPaired(res.token, res.device);
    } catch (err) {
      setError(describePairError(err, t));
      setBusy(false);
    }
  };

  return (
    <div className="rm-pair">
      <form
        className="rm-pair__card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="rm-pair__logo" aria-hidden="true">
          <Icon name="wave" size={28} />
        </div>
        <h1>{t('pair.title')}</h1>
        {revoked && (
          <p className="rm-pair__notice" role="status">
            <Icon name="info" size={16} />
            {t('pair.revoked')}
          </p>
        )}
        <p className="rm-pair__intro">{t('pair.intro')}</p>

        <label className="rm-pair__field">
          <span>{t('pair.code')}</span>
          <input
            ref={codeRef}
            className="hq-input rm-pair__code hq-mono"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d\s-]/g, '').slice(0, 9))}
            inputMode="numeric"
            autoComplete="one-time-code"
            enterKeyHint="go"
            placeholder="000 000"
            aria-invalid={error !== null}
          />
        </label>
        <label className="rm-pair__field">
          <span>{t('pair.deviceName')}</span>
          <input
            className="hq-input"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            autoComplete="off"
            maxLength={60}
          />
          <small className="hq-muted">{t('pair.deviceNameHint')}</small>
        </label>

        {error && (
          <p className="rm-pair__error" role="alert">
            <Icon name="warning" size={16} />
            {error}
          </p>
        )}

        <button
          type="submit"
          className="hq-btn hq-btn--primary rm-pair__submit"
          disabled={!valid || busy}
        >
          {busy ? <Spinner size={16} /> : <Icon name="check" size={16} />}
          {t('pair.submit')}
        </button>

        {isIos() && !isStandalone() && <p className="rm-pair__hint">{t('pair.homeScreen')}</p>}
        <p className="rm-pair__hint">
          <Icon name="info" size={14} />
          {t('remote.noAudio')}
        </p>
      </form>
    </div>
  );
}
