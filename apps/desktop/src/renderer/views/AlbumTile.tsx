import type { AlbumDetail, AlbumSummary } from '@hqps/contracts';
import {
  Artwork,
  Icon,
  MenuButton,
  Spinner,
  buildHref,
  formatDuration,
  useCapabilityGate,
  useStudio,
  useT,
  useTrackActions,
  type MenuItem,
} from '@hqps/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Hover this long before the album opens. Long enough that reaching for the play button, or
 * sweeping across the grid, opens nothing.
 */
const OPEN_DELAY_MS = 900;
/** Grace period for moving the pointer between the cover and the panel. */
const CLOSE_DELAY_MS = 180;
/** Matches the `peek-out` animation in app.css. */
const CLOSE_ANIM_MS = 170;
const PANEL_WIDTH = 460;
const EDGE = 12;

type Phase = 'closed' | 'open' | 'closing';

/**
 * An album cover for the grids. Hovering shows a play button straight away (plays the whole
 * album); resting on the cover a little longer grows it into a panel listing the album's tracks:
 * play one track, or tick several and play, queue or add them to a playlist. Clicking the cover
 * still opens the album page.
 */
export function AlbumTile({
  album,
  index = 0,
}: {
  album: AlbumSummary;
  /** Position in its grid — staggers the entrance animation. */
  index?: number;
}) {
  const t = useT();
  const { playAlbum, pending } = useStudio();
  const playReason = useCapabilityGate()('queue.replace');
  const href = buildHref('/albums', album.id);
  const [phase, setPhase] = useState<Phase>('closed');
  const anchorRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The pointer is over the cover or the panel. */
  const inside = useRef(false);
  /** The pointer is on the play button: the user is about to play, not browse the tracks. */
  const onPlayButton = useRef(false);
  const sub = [album.albumArtist, album.year].filter(Boolean).join(' · ');

  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  useEffect(() => clearTimers, []);

  const close = useCallback(() => {
    clearTimers();
    setPhase((p) => (p === 'open' ? 'closing' : p));
  }, []);
  useEffect(() => {
    if (phase !== 'closing') return;
    const id = setTimeout(() => setPhase('closed'), CLOSE_ANIM_MS);
    return () => clearTimeout(id);
  }, [phase]);

  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(function attempt() {
      if (inside.current) return;
      // A menu opened from the panel (add to playlist) lives outside it: wait for it to close.
      if (document.querySelector('.hq-menu')) {
        closeTimer.current = setTimeout(attempt, 250);
        return;
      }
      close();
    }, CLOSE_DELAY_MS);
  }, [close]);

  const enter = () => {
    inside.current = true;
    clearTimeout(closeTimer.current);
    if (phase !== 'closed') {
      setPhase('open');
      return;
    }
    armOpen();
  };
  /** (Re)start the wait before the panel opens — never while the pointer is on the play button. */
  const armOpen = () => {
    clearTimeout(openTimer.current);
    if (onPlayButton.current) return;
    openTimer.current = setTimeout(() => setPhase('open'), OPEN_DELAY_MS);
  };
  const leave = () => {
    inside.current = false;
    clearTimeout(openTimer.current);
    if (phase !== 'closed') scheduleClose();
  };

  return (
    <div
      className={`hq-album-card${album.available ? '' : ' is-unavailable'}${phase === 'open' ? ' is-open' : ''}`}
      style={{ '--i': index } as CSSProperties}
      // The panel is a portal but still a React child, so moving the pointer between the
      // cover and the panel does not count as leaving.
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <div className="hq-album-card__media" ref={anchorRef}>
        <a className="hq-album-card__art" href={href} aria-label={album.title}>
          <Artwork artworkId={album.artworkId} alt="" />
          <span className="hq-album-card__format">{album.formatLabel}</span>
        </a>
        <button
          type="button"
          className="hq-album-card__play"
          onMouseEnter={() => {
            onPlayButton.current = true;
            clearTimeout(openTimer.current);
          }}
          onMouseLeave={() => {
            onPlayButton.current = false;
            // back on the cover: the wait starts over
            if (inside.current && phase === 'closed') armOpen();
          }}
          onClick={() => {
            // playing was the point: don't also open the track panel
            clearTimeout(openTimer.current);
            void playAlbum(album.id);
          }}
          disabled={!!playReason || pending.has('queue') || !album.available}
          title={playReason ?? t('actions.playAlbum')}
          aria-label={`${t('actions.playAlbum')}: ${album.title}`}
        >
          <Icon name="play" size={22} />
        </button>
      </div>
      <a className="hq-album-card__title" href={href} title={album.title}>
        {album.title}
      </a>
      <div className="hq-album-card__sub" title={sub}>
        {sub}
      </div>
      {phase !== 'closed' && (
        <AlbumPeek
          album={album}
          anchor={anchorRef.current}
          closing={phase === 'closing'}
          onClose={close}
        />
      )}
    </div>
  );
}

interface Placement {
  left: number;
  top: number;
  origin: string;
  from: number;
}

function place(anchor: HTMLElement | null, height: number): Placement {
  const rect = anchor?.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(PANEL_WIDTH, vw - 2 * EDGE);
  if (!rect) return { left: EDGE, top: EDGE, origin: 'top left', from: 0.4 };
  // Grow rightwards from the cover unless that would leave the window.
  const growRight = rect.left - EDGE + width <= vw - EDGE;
  const left = growRight
    ? Math.max(EDGE, rect.left - EDGE)
    : Math.max(EDGE, Math.min(vw - EDGE - width, rect.right + EDGE - width));
  // Start level with the cover; slide up only as far as needed to stay on screen.
  const top = Math.max(EDGE, Math.min(rect.top - EDGE, vh - EDGE - height));
  const originY = Math.max(0, Math.min(height, rect.top - top));
  return {
    left,
    top,
    origin: `${growRight ? 'left' : 'right'} ${Math.round(originY)}px`,
    from: Math.max(0.25, Math.min(0.9, rect.width / width)),
  };
}

function AlbumPeek({
  album,
  anchor,
  closing,
  onClose,
}: {
  album: AlbumSummary;
  anchor: HTMLElement | null;
  closing: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const studio = useStudio();
  const gate = useCapabilityGate();
  const { addToNewPlaylist } = useTrackActions();
  const { client, pending } = studio;
  const ref = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<AlbumDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pos, setPos] = useState<Placement>(() => place(anchor, 420));

  useEffect(() => {
    let alive = true;
    client.library
      .album(album.id)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [client, album.id]);

  // Re-place once the real height is known (track count differs per album).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos(place(anchor, el.offsetHeight));
  }, [anchor, detail, failed]);

  // The panel is anchored to a cover: once the page scrolls or resizes it no longer lines up.
  useEffect(() => {
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return; // its own track list
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('hashchange', onClose);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('hashchange', onClose);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const href = buildHref('/albums', album.id);
  const source = { kind: 'album' as const, id: album.id, label: album.title };
  const playReason = gate('queue.replace');
  const appendReason = gate('queue.append');
  const busy = pending.has('queue');
  const tracks = detail?.tracks ?? [];
  const playable = tracks.filter((tr) => tr.available);
  // Actions apply to the ticked tracks, or to the whole album when nothing is ticked.
  const chosen = tracks.filter((tr) => selected.has(tr.id)).map((tr) => tr.id);
  const targetIds = chosen.length ? chosen : playable.map((tr) => tr.id);
  const meta = [
    album.year,
    album.genre,
    t('common.tracksCount', { count: album.trackCount }),
  ].filter(Boolean);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const playlistItems = (): MenuItem[] => [
    ...studio.playlists.map<MenuItem>((pl) => ({
      label: pl.name,
      icon: 'playlist',
      onSelect: () => void studio.addToPlaylist(pl, targetIds),
    })),
    ...(studio.playlists.length ? [{ type: 'separator' } as MenuItem] : []),
    {
      label: t('actions.newPlaylist'),
      icon: 'plus',
      onSelect: () => void addToNewPlaylist(targetIds),
    },
  ];

  return createPortal(
    <div
      ref={ref}
      className={`album-peek${closing ? ' is-closing' : ''}`}
      role="dialog"
      aria-label={album.title}
      style={
        {
          left: pos.left,
          top: pos.top,
          '--peek-origin': pos.origin,
          '--peek-from': pos.from,
        } as CSSProperties
      }
    >
      <div className="album-peek__head">
        <a className="album-peek__cover" href={href} aria-label={album.title}>
          <Artwork artworkId={album.artworkId} alt="" />
        </a>
        <div className="album-peek__info">
          <a className="album-peek__title" href={href}>
            {album.title}
          </a>
          <a
            className="album-peek__artist"
            href={
              album.albumArtistId
                ? buildHref('/artists', album.albumArtistId)
                : buildHref('/search', { q: album.albumArtist })
            }
          >
            {album.albumArtist}
          </a>
          <div className="album-peek__meta">
            <span className="hq-badge">{album.formatLabel}</span>
            <span>{meta.join(' · ')}</span>
          </div>
        </div>
        <button
          type="button"
          className="album-peek__playall"
          onClick={() => void studio.playAlbum(album.id)}
          disabled={!!playReason || busy || playable.length === 0}
          title={playReason ?? t('actions.playAlbum')}
          aria-label={t('actions.playAlbum')}
        >
          <Icon name="play" size={26} />
        </button>
      </div>

      {!detail ? (
        <div className="album-peek__state">
          {failed ? t('common.error') : <Spinner size={20} label={t('common.loading')} />}
        </div>
      ) : (
        <ul className="album-peek__tracks">
          {tracks.map((tr, i) => {
            const on = selected.has(tr.id);
            return (
              <li
                key={tr.id}
                className={`album-peek__row${on ? ' is-selected' : ''}${tr.available ? '' : ' is-unavailable'}`}
                style={{ '--i': i } as CSSProperties}
              >
                <button
                  type="button"
                  className="album-peek__pick"
                  onClick={() => toggle(tr.id)}
                  disabled={!tr.available}
                  aria-pressed={on}
                  title={tr.title}
                >
                  <span className="album-peek__box">
                    <Icon name="check" size={14} />
                  </span>
                  <span className="album-peek__num">{tr.trackNumber ?? i + 1}</span>
                  <span className="album-peek__name">{tr.title}</span>
                  <span className="album-peek__dur">{formatDuration(tr.durationMs)}</span>
                </button>
                <button
                  type="button"
                  className="album-peek__play"
                  onClick={() => void studio.playTracks([tr.id], { source })}
                  disabled={!!playReason || busy || !tr.available}
                  title={playReason ?? t('common.play')}
                  aria-label={`${t('common.play')}: ${tr.title}`}
                >
                  <Icon name="play" size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="album-peek__actions">
        {chosen.length > 0 && (
          <button
            type="button"
            className="hq-btn hq-btn--primary"
            onClick={() => void studio.playTracks(chosen, { source })}
            disabled={!!playReason || busy}
            title={playReason ?? undefined}
          >
            <Icon name="play" size={16} />
            {t('peek.playSelected', { count: chosen.length })}
          </button>
        )}
        <button
          type="button"
          className="hq-btn"
          onClick={() => void studio.queueAdd(targetIds, 'next')}
          disabled={!!appendReason || targetIds.length === 0}
          title={appendReason ?? t('actions.playNext')}
        >
          <Icon name="playNext" size={16} />
          {t('peek.next')}
        </button>
        <button
          type="button"
          className="hq-btn"
          onClick={() => void studio.queueAdd(targetIds, 'end')}
          disabled={!!appendReason || targetIds.length === 0}
          title={appendReason ?? t('actions.addToQueue')}
        >
          <Icon name="queueAdd" size={16} />
          {t('peek.queue')}
        </button>
        <MenuButton
          label={t('actions.addToPlaylist')}
          className="hq-btn"
          disabled={targetIds.length === 0}
          items={playlistItems}
        >
          <Icon name="plus" size={16} />
          <span>{t('peek.playlist')}</span>
        </MenuButton>
        {chosen.length > 0 && (
          <button
            type="button"
            className="hq-btn hq-btn--ghost album-peek__end"
            onClick={() => setSelected(new Set())}
          >
            {t('peek.clear')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
