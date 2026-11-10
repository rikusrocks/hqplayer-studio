import {
  ConnectionBadge,
  Icon,
  LOCALES,
  useI18n,
  useStudio,
  useTheme,
  type Locale,
  type Theme,
} from '@hqps/ui';
import { useEffect } from 'react';

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useTheme();
  const { server, capabilities, realtime } = useStudio();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const engine = capabilities?.engine;
  return (
    <div className="rm-sheet-backdrop" onClick={onClose}>
      <div
        className="rm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rm-sheet__grip" aria-hidden="true" />
        <div className="rm-sheet__head">
          <h2 id="rm-sheet-title">{t('remote.settings')}</h2>
          <button
            type="button"
            className="hq-icon-btn"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="rm-sheet__group">
          <div className="rm-kv">
            <span>{t('diag.connection')}</span>
            <ConnectionBadge />
          </div>
          <div className="rm-kv">
            <span>{t('diag.realtime')}</span>
            <strong>{t(`realtime.${realtime}`)}</strong>
          </div>
          <div className="rm-kv">
            <span>{t('remote.server')}</span>
            <strong className="hq-mono">{window.location.host}</strong>
          </div>
          <div className="rm-kv">
            <span>{t('diag.adapter')}</span>
            <strong>{server?.adapter ?? capabilities?.adapter ?? '—'}</strong>
          </div>
          {engine && (
            <div className="rm-kv">
              <span>{t('diag.engine')}</span>
              <strong>{[engine.product, engine.version].filter(Boolean).join(' ')}</strong>
            </div>
          )}
          <div className="rm-kv">
            <span>{t('diag.app')}</span>
            <strong>{server?.appVersion ?? '—'}</strong>
          </div>
        </div>

        <div className="rm-sheet__group">
          <label className="rm-kv">
            <span>{t('settings.language')}</span>
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
          <label className="rm-kv">
            <span>{t('settings.theme')}</span>
            <select
              className="hq-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
            >
              <option value="dark">{t('settings.theme.dark')}</option>
              <option value="light">{t('settings.theme.light')}</option>
            </select>
          </label>
        </div>

        <p className="rm-note">
          <Icon name="info" size={14} />
          {t('remote.noAudio')}
        </p>
        <p className="rm-note rm-note--small">{t('app.disclaimer')}</p>
      </div>
    </div>
  );
}
