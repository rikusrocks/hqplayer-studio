import type { CoverCandidate } from '@hqps/contracts';
import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../data/StudioProvider';
import { useT } from '../i18n/I18nProvider';
import { Icon } from './Icon';
import { Spinner } from './basics';

const keyOf = (c: CoverCandidate) => `${c.provider}:${c.ref}`;

/**
 * Pick a cover for an album from the enabled online sources (desktop, this computer only).
 * Thumbnails come through Core (`/covers/preview`), so the page itself never contacts a source.
 */
export function CoverSearchDialog({
  albumId,
  title,
  artist,
  settingsHref,
  onClose,
}: {
  albumId: string;
  title: string;
  artist: string;
  settingsHref?: string;
  onClose: () => void;
}) {
  const t = useT();
  const { client, run } = useStudio();
  const [onlineEnabled, setOnlineEnabled] = useState<boolean | null>(null);
  const [query, setQuery] = useState(`${artist} ${title}`.trim());
  const [results, setResults] = useState<CoverCandidate[] | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // `run` changes identity whenever a toast appears; the first search must not start over then.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Settings first: with online covers off nothing may be sent anywhere.
  useEffect(() => {
    let alive = true;
    client.covers
      .settings()
      .then((s) => {
        if (!alive) return;
        const on = s.online && s.providers.some((p) => p.enabled);
        setOnlineEnabled(on);
        if (!on) return;
        setBusy(true);
        return runRef
          .current(() => client.covers.search(albumId))
          .then((res) => {
            if (!alive) return;
            setBusy(false);
            if (res) setResults(res);
          });
      })
      .catch(() => {
        if (alive) setOnlineEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, [client, albumId]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    const res = await run(() => client.covers.search(albumId, query.trim()));
    setBusy(false);
    if (res) {
      setBroken(new Set());
      setResults(res);
    }
  };
  const choose = async (c: CoverCandidate) => {
    setBusy(true);
    const res = await run(() => client.covers.select(albumId, c), {
      success: t('covers.selected'),
    });
    setBusy(false);
    if (res) onClose();
  };
  // A source may list an album without having its cover (common at the Cover Art Archive).
  const shown = results?.filter((c) => !broken.has(keyOf(c))) ?? null;

  return (
    <div
      className="hq-dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="hq-dialog hq-dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hq-cover-search-title"
      >
        <h2 id="hq-cover-search-title" className="hq-dialog__title">
          {t('covers.searchTitle', { title })}
        </h2>
        {onlineEnabled === null ? (
          <div className="hq-loading">
            <Spinner size={16} />
          </div>
        ) : !onlineEnabled ? (
          <>
            <p className="hq-dialog__message">{t('covers.onlineOff')}</p>
            <div className="hq-dialog__actions">
              <button type="button" className="hq-btn hq-btn--ghost" onClick={onClose}>
                {t('common.close')}
              </button>
              {settingsHref && (
                <a className="hq-btn hq-btn--primary" href={settingsHref} onClick={onClose}>
                  {t('covers.openSettings')}
                </a>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="hq-dialog__message">{t('covers.searchPrivacy')}</p>
            <form
              className="hq-lyrics-search__form"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <input
                className="hq-input"
                value={query}
                maxLength={200}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('covers.searchPlaceholder')}
                placeholder={t('covers.searchPlaceholder')}
              />
              <button
                type="submit"
                className="hq-btn hq-btn--primary"
                disabled={busy || !query.trim()}
              >
                {busy ? <Spinner size={14} /> : <Icon name="search" size={14} />}
                {t('nav.search')}
              </button>
            </form>
            {shown && shown.length === 0 && <p className="hq-muted">{t('covers.searchEmpty')}</p>}
            {shown && shown.length > 0 && (
              <ul className="hq-cover-search__grid">
                {shown.map((c) => (
                  <li key={keyOf(c)}>
                    <button
                      type="button"
                      className="hq-cover-search__item"
                      disabled={busy}
                      onClick={() => void choose(c)}
                      title={t('covers.use')}
                    >
                      <img
                        className="hq-cover-search__img"
                        src={client.covers.previewUrl(c)}
                        alt=""
                        loading="lazy"
                        onError={() => setBroken((prev) => new Set(prev).add(keyOf(c)))}
                      />
                      <strong className="hq-cover-search__title">{c.title}</strong>
                      <span className="hq-cover-search__meta">
                        {[
                          c.artist,
                          c.year,
                          c.trackCount !== null
                            ? t('covers.tracks', { count: c.trackCount })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <span className="hq-badge">{t(`covers.provider.${c.provider}`)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="hq-dialog__actions">
              <button type="button" className="hq-btn hq-btn--ghost" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
