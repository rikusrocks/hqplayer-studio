import type { LyricsCandidate, TrackLyrics } from '@hqps/contracts';
import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../data/StudioProvider';
import { formatDuration } from '../format';
import { useActiveLyricIndex, useTrackLyrics } from '../hooks/useLyrics';
import { useNowPlaying } from '../hooks/useNowPlaying';
import { useT } from '../i18n/I18nProvider';
import { Icon } from './Icon';
import { EmptyState, Spinner } from './basics';

const STEP_MS = 500;

/** "+0.5 s" / "−1.2 s" / "0 s". */
export function formatOffset(ms: number): string {
  if (ms === 0) return '0 s';
  const s = Math.abs(ms) / 1000;
  return `${ms > 0 ? '+' : '−'}${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

export interface LyricsPanelProps {
  /** Desktop: offer LRCLIB search / re-match (this computer only). */
  manage?: boolean;
  /** Desktop: open Settings → 歌词 (hint links). */
  settingsHref?: string;
  className?: string;
}

/**
 * Lyrics of what HQPlayer is playing. Synced lyrics follow the audible position (HQPlayer's
 * output buffer is already subtracted) plus the user's per-track calibration; plain lyrics are
 * static. Never affects playback — lyrics failures only show here.
 */
export function LyricsPanel({ manage = false, settingsHref, className }: LyricsPanelProps) {
  const t = useT();
  const { status } = useStudio();
  const now = useNowPlaying();
  const trackId = now.hasTrack
    ? (now.libraryTrack?.id ?? status.track?.studioTrackId ?? null)
    : null;
  const { lyrics, loading, error, reload, setOffset } = useTrackLyrics(trackId);
  const [searching, setSearching] = useState(false);
  const cls = `hq-lyrics${className ? ` ${className}` : ''}`;

  if (!now.hasTrack) {
    return (
      <div className={cls}>
        <EmptyState icon="lyrics" title={t('player.nothingPlaying')} />
      </div>
    );
  }
  if (!trackId) {
    return (
      <div className={cls}>
        <EmptyState icon="lyrics" title={t('lyrics.notInLibrary')} />
      </div>
    );
  }
  if (!lyrics || lyrics.trackId !== trackId) {
    return (
      <div className={cls}>
        {error ? (
          <EmptyState
            icon="warning"
            title={t('lyrics.loadFailed')}
            action={
              <button type="button" className="hq-btn hq-btn--sm" onClick={reload}>
                <Icon name="refresh" size={14} />
                {t('common.retry')}
              </button>
            }
          />
        ) : (
          <div className="hq-loading">
            <Spinner size={16} />
            <span>{t('lyrics.loading')}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cls}>
      {lyrics.state === 'found' && lyrics.kind === 'synced' && <SyncedLines lyrics={lyrics} />}
      {lyrics.state === 'found' && lyrics.kind === 'plain' && (
        <div className="hq-lyrics__scroll hq-lyrics__scroll--plain">
          <p className="hq-lyrics__note">{t('lyrics.plainNote')}</p>
          {lyrics.plain.map((line, i) => (
            <p key={i} className="hq-lyrics__line">
              {line || ' '}
            </p>
          ))}
        </div>
      )}
      {lyrics.state === 'found' && lyrics.instrumental && (
        <EmptyState icon="track" title={t('lyrics.instrumental')} />
      )}
      {lyrics.state === 'not_found' && (
        <EmptyState
          icon="lyrics"
          title={t('lyrics.notFound')}
          hint={
            lyrics.online.enabled
              ? t('lyrics.notFoundOnlineHint')
              : manage
                ? t('lyrics.notFoundLocalHint')
                : t('lyrics.notFoundRemoteHint')
          }
          action={
            !lyrics.online.enabled && settingsHref ? (
              <a className="hq-btn hq-btn--sm" href={settingsHref}>
                <Icon name="settings" size={14} />
                {t('lyrics.openSettings')}
              </a>
            ) : undefined
          }
        />
      )}
      {lyrics.state === 'unavailable' && (
        <EmptyState
          icon="warning"
          title={t('lyrics.unavailable')}
          hint={t('lyrics.unavailableHint')}
        />
      )}

      <LyricsFooter
        lyrics={lyrics}
        loading={loading}
        manage={manage}
        outputDelayMs={status.outputDelayMs}
        onOffset={setOffset}
        onSearch={() => setSearching(true)}
      />
      {searching && (
        <LyricsSearchDialog
          trackId={trackId}
          title={now.title ?? ''}
          artist={now.artist ?? ''}
          onlineEnabled={lyrics.online.enabled}
          settingsHref={settingsHref}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}

function SyncedLines({ lyrics }: { lyrics: TrackLyrics }) {
  const active = useActiveLyricIndex(lyrics);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrollAt = useRef(0);

  // Keep the active line in the middle — unless the user just scrolled to read ahead.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || active < 0 || Date.now() - userScrollAt.current < 5000) return;
    const el = box.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (!el) return;
    const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [active]);

  const markUserScroll = () => {
    userScrollAt.current = Date.now();
  };

  return (
    <div
      className="hq-lyrics__scroll"
      ref={scrollRef}
      onWheel={markUserScroll}
      onTouchMove={markUserScroll}
      aria-live="off"
    >
      {lyrics.lines.map((line, i) => (
        <p
          key={i}
          data-line={i}
          className={`hq-lyrics__line${i === active ? ' is-active' : ''}${i < active ? ' is-past' : ''}`}
          aria-current={i === active ? 'true' : undefined}
        >
          {line.text || ' '}
        </p>
      ))}
    </div>
  );
}

function LyricsFooter({
  lyrics,
  loading,
  manage,
  outputDelayMs,
  onOffset,
  onSearch,
}: {
  lyrics: TrackLyrics;
  loading: boolean;
  manage: boolean;
  outputDelayMs: number | null;
  onOffset: (ms: number) => void;
  onSearch: () => void;
}) {
  const t = useT();
  const { client, run } = useStudio();
  const synced = lyrics.state === 'found' && lyrics.kind === 'synced';
  return (
    <div className="hq-lyrics__footer">
      <div className="hq-lyrics__source">
        {lyrics.source && (
          <span className="hq-badge">
            {t(`lyrics.source.${lyrics.source}`)}
            {lyrics.selectedByUser ? ` · ${t('lyrics.manual')}` : ''}
          </span>
        )}
        {loading && <Spinner size={12} />}
      </div>
      {synced && (
        <div className="hq-lyrics__offset" role="group" aria-label={t('lyrics.offsetLabel')}>
          <button
            type="button"
            className="hq-icon-btn hq-icon-btn--sm"
            onClick={() => onOffset(lyrics.offsetMs - STEP_MS)}
            title={t('lyrics.earlier')}
            aria-label={t('lyrics.earlier')}
          >
            −
          </button>
          <button
            type="button"
            className="hq-lyrics__offset-value"
            onClick={() => onOffset(0)}
            title={t('lyrics.offsetReset')}
          >
            {formatOffset(lyrics.offsetMs)}
          </button>
          <button
            type="button"
            className="hq-icon-btn hq-icon-btn--sm"
            onClick={() => onOffset(lyrics.offsetMs + STEP_MS)}
            title={t('lyrics.later')}
            aria-label={t('lyrics.later')}
          >
            +
          </button>
        </div>
      )}
      {manage && (
        <div className="hq-lyrics__manage">
          <button type="button" className="hq-btn hq-btn--sm hq-btn--ghost" onClick={onSearch}>
            <Icon name="search" size={14} />
            {t('lyrics.search')}
          </button>
          {(lyrics.selectedByUser || lyrics.state !== 'found') && (
            <button
              type="button"
              className="hq-btn hq-btn--sm hq-btn--ghost"
              onClick={() => void run(() => client.lyrics.reset(lyrics.trackId))}
              title={t('lyrics.rematchHint')}
            >
              <Icon name="refresh" size={14} />
              {t('lyrics.rematch')}
            </button>
          )}
        </div>
      )}
      {synced && outputDelayMs !== null && outputDelayMs > 200 && (
        <p className="hq-lyrics__note">
          {t('lyrics.delayNote', { seconds: (outputDelayMs / 1000).toFixed(1) })}
        </p>
      )}
    </div>
  );
}

function LyricsSearchDialog({
  trackId,
  title,
  artist,
  onlineEnabled,
  settingsHref,
  onClose,
}: {
  trackId: string;
  title: string;
  artist: string;
  onlineEnabled: boolean;
  settingsHref?: string;
  onClose: () => void;
}) {
  const t = useT();
  const { client, run } = useStudio();
  const [query, setQuery] = useState(`${title} ${artist}`.trim());
  const [results, setResults] = useState<LyricsCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    const res = await run(() => client.lyrics.search(trackId, query.trim()));
    setBusy(false);
    if (res) setResults(res);
  };
  const choose = async (c: LyricsCandidate) => {
    setBusy(true);
    const res = await run(() => client.lyrics.select(trackId, c.lrclibId), {
      success: t('lyrics.selected'),
    });
    setBusy(false);
    if (res) onClose();
  };

  return (
    <div
      className="hq-dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="hq-dialog hq-dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hq-lyrics-search-title"
      >
        <h2 id="hq-lyrics-search-title" className="hq-dialog__title">
          {t('lyrics.searchTitle', { title })}
        </h2>
        {!onlineEnabled ? (
          <>
            <p className="hq-dialog__message">{t('lyrics.onlineOff')}</p>
            <div className="hq-dialog__actions">
              <button type="button" className="hq-btn hq-btn--ghost" onClick={onClose}>
                {t('common.close')}
              </button>
              {settingsHref && (
                <a className="hq-btn hq-btn--primary" href={settingsHref} onClick={onClose}>
                  {t('lyrics.openSettings')}
                </a>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="hq-dialog__message">{t('lyrics.searchPrivacy')}</p>
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
                aria-label={t('lyrics.searchPlaceholder')}
                placeholder={t('lyrics.searchPlaceholder')}
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
            {results && results.length === 0 && (
              <p className="hq-muted">{t('lyrics.searchEmpty')}</p>
            )}
            {results && results.length > 0 && (
              <ul className="hq-lyrics-search__list">
                {results.map((c) => (
                  <li key={c.lrclibId} className="hq-lyrics-search__item">
                    <div className="hq-lyrics-search__meta">
                      <strong>{c.trackName}</strong>
                      <span className="hq-muted">
                        {[
                          c.artistName,
                          c.albumName,
                          c.durationMs ? formatDuration(c.durationMs) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <span className="hq-lyrics-search__preview">
                        {c.instrumental ? t('lyrics.instrumental') : c.preview.join(' / ')}
                      </span>
                    </div>
                    <span className="hq-badge">
                      {c.synced ? t('lyrics.synced') : t('lyrics.plain')}
                    </span>
                    <button
                      type="button"
                      className="hq-btn hq-btn--sm"
                      disabled={busy}
                      onClick={() => void choose(c)}
                    >
                      {t('lyrics.use')}
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
