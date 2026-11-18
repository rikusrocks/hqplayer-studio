import {
  Artwork,
  FormatBadge,
  Icon,
  LyricsPanel,
  QueueList,
  QueueSyncBanner,
  buildHref,
  formatDuration,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';
import { useCallback, useRef, useState, type PointerEvent } from 'react';

type Tab = 'now' | 'lyrics' | 'queue';
const TABS: Tab[] = ['now', 'lyrics', 'queue'];
const TAB_KEY = 'hqps.desktop.panelTab';

function readTab(): Tab {
  try {
    const v = globalThis.localStorage?.getItem(TAB_KEY);
    return TABS.includes(v as Tab) ? (v as Tab) : 'queue';
  } catch {
    return 'queue';
  }
}

const TAB_LABEL = { now: 'nav.nowPlaying', lyrics: 'nav.lyrics', queue: 'nav.queue' } as const;

const WIDTH_KEY = 'hqps.desktop.panel.width';
/** Default width of the side panel (queue / lyrics / now playing). */
export const PANEL_DEFAULT_WIDTH = 344;
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 720;
/** The library content always keeps at least this much room next to the panel. */
const CONTENT_MIN_WIDTH = 420;

function clampPanel(w: number, sidebarWidth: number): number {
  const room = (globalThis.innerWidth ?? 1600) - sidebarWidth - CONTENT_MIN_WIDTH;
  const max = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, room));
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, w)));
}

export interface PanelWidthState {
  width: number;
  dragging: boolean;
  startResize: (e: PointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
}

/** Width of the side panel, dragged at its left edge and remembered across launches. */
export function usePanelWidth(sidebarWidth: number): PanelWidthState {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(globalThis.localStorage?.getItem(WIDTH_KEY));
      return Number.isFinite(stored) && stored > 0
        ? Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, stored))
        : PANEL_DEFAULT_WIDTH;
    } catch {
      return PANEL_DEFAULT_WIDTH;
    }
  });
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const save = (w: number) => {
    try {
      globalThis.localStorage?.setItem(WIDTH_KEY, String(w));
    } catch {
      // ignore
    }
  };

  const startResize = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);
      const onMove = (ev: globalThis.PointerEvent) => {
        setWidth(clampPanel(globalThis.innerWidth - ev.clientX, sidebarWidth));
      };
      const stop = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        setDragging(false);
        save(widthRef.current);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    },
    [sidebarWidth],
  );

  const resetWidth = useCallback(() => {
    setWidth(PANEL_DEFAULT_WIDTH);
    save(PANEL_DEFAULT_WIDTH);
  }, []);

  return { width, dragging, startResize, resetWidth };
}

export function SidePanel({ onClose, size }: { onClose: () => void; size: PanelWidthState }) {
  const t = useT();
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (next: Tab) => {
    setTabState(next);
    try {
      globalThis.localStorage?.setItem(TAB_KEY, next);
    } catch {
      // ignore
    }
  };

  return (
    <aside className="sidepanel" aria-label={t('queue.title')}>
      {/* drag the left edge to resize, double-click for the default width */}
      <button
        type="button"
        className={`sidepanel__resize${size.dragging ? ' is-dragging' : ''}`}
        onPointerDown={size.startResize}
        onDoubleClick={size.resetWidth}
        aria-label={t('sidebar.resize')}
        title={t('sidebar.resize')}
        tabIndex={-1}
      >
        <span />
      </button>
      <div className="sidepanel__tabs" role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`sidepanel__tab${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
        <span className="sidepanel__spacer" />
        <button
          type="button"
          className="hq-icon-btn hq-icon-btn--sm"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div
        className={`sidepanel__body${tab === 'lyrics' ? ' sidepanel__body--lyrics' : ''}`}
        role="tabpanel"
      >
        {tab === 'now' && <NowPlayingPanel />}
        {tab === 'lyrics' && <LyricsPanel manage settingsHref="#/settings/lyrics" />}
        {tab === 'queue' && <QueueList />}
      </div>
    </aside>
  );
}

function NowPlayingPanel() {
  const t = useT();
  const { status } = useStudio();
  const now = useNowPlaying();

  if (!now.hasTrack) {
    return (
      <div className="np-panel">
        <QueueSyncBanner />
        <div className="np-panel__art">
          <Artwork artworkId={null} size="full" />
        </div>
        <p className="hq-muted">{t('player.nothingPlaying')}</p>
      </div>
    );
  }

  const albumHref = now.libraryTrack?.albumId
    ? buildHref('/albums', now.libraryTrack.albumId)
    : null;
  const dsp = status.dsp;
  const rows: Array<[string, string | null]> = [
    [t('settings.dspMode'), dsp?.mode ?? null],
    [t('settings.dspFilter'), dsp?.filter ?? null],
    [t('settings.dspShaper'), dsp?.shaper ?? null],
    [t('settings.dspRate'), status.output?.label ?? null],
  ];

  return (
    <div className="np-panel">
      <QueueSyncBanner />
      <div className="np-panel__art">
        <Artwork artworkId={now.artworkId} size="full" />
      </div>
      <div className="np-panel__meta">
        <h2 className="np-panel__title">{now.title}</h2>
        <div className="np-panel__artist">{now.artist}</div>
        {now.album &&
          (albumHref ? (
            <a className="np-panel__album" href={albumHref}>
              {now.album}
            </a>
          ) : (
            <div className="np-panel__album">{now.album}</div>
          ))}
      </div>
      <FormatBadge inputLabel={now.inputLabel} output={status.output} />
      <dl className="np-panel__dsp">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v ?? '—'}</dd>
          </div>
        ))}
        <div>
          <dt>{t('col.duration')}</dt>
          <dd>{formatDuration(now.durationMs)}</dd>
        </div>
      </dl>
    </div>
  );
}
