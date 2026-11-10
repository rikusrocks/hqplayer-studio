/**
 * Desktop integration that Electron offers on Windows: global media keys and a tray icon.
 * Pure logic (preferences, key registration bookkeeping, tray menu model) lives here so it can be
 * tested without Electron; main.ts wires it to `globalShortcut`, `Tray` and `Menu`.
 *
 * Studio never plays audio itself, so Windows' own media overlay (SMTC) cannot show it — that
 * needs an audio session. Media keys and the tray act on HQPlayer through the same checked
 * commands as the buttons in the app (and only while “允许 Studio 控制 HQPlayer” is on).
 */

export interface ShellPrefs {
  /** Keyboard media keys (Play/Pause, Next, Previous, Stop) control HQPlayer via Studio. */
  mediaKeys: boolean;
  /** Show a tray (notification area) icon with playback controls. */
  tray: boolean;
  /** With the tray icon on: closing the main window keeps Studio running (Web Remote stays up). */
  closeToTray: boolean;
}

export const DEFAULT_SHELL_PREFS: ShellPrefs = { mediaKeys: true, tray: false, closeToTray: false };

export function normalizeShellPrefs(raw: unknown): ShellPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const tray = bool(o.tray, DEFAULT_SHELL_PREFS.tray);
  return {
    mediaKeys: bool(o.mediaKeys, DEFAULT_SHELL_PREFS.mediaKeys),
    tray,
    // closing to the tray without a tray icon would leave Studio invisible
    closeToTray: tray && bool(o.closeToTray, DEFAULT_SHELL_PREFS.closeToTray),
  };
}

export type MediaAction = 'toggle' | 'next' | 'previous' | 'stop';

export const MEDIA_KEYS: ReadonlyArray<{ accelerator: string; action: MediaAction }> = [
  { accelerator: 'MediaPlayPause', action: 'toggle' },
  { accelerator: 'MediaNextTrack', action: 'next' },
  { accelerator: 'MediaPreviousTrack', action: 'previous' },
  { accelerator: 'MediaStop', action: 'stop' },
];

/** The parts of Electron's `globalShortcut` used here. */
export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface MediaKeyState {
  supported: boolean;
  enabled: boolean;
  /** Keys Studio holds right now. */
  registered: string[];
  /** Keys another program already holds (Windows gives each global key to one program). */
  unavailable: string[];
}

/**
 * Register or release the media keys to match `enabled`. A key another program owns is
 * reported, not fought over.
 */
export function syncMediaKeys(
  registrar: ShortcutRegistrar,
  enabled: boolean,
  onAction: (action: MediaAction) => void,
  supported = true,
): MediaKeyState {
  const registered: string[] = [];
  const unavailable: string[] = [];
  for (const { accelerator, action } of MEDIA_KEYS) {
    const mine = registrar.isRegistered(accelerator);
    if (!enabled || !supported) {
      if (mine) registrar.unregister(accelerator);
      continue;
    }
    if (mine) {
      registered.push(accelerator);
      continue;
    }
    let ok: boolean;
    try {
      ok = registrar.register(accelerator, () => onAction(action));
    } catch {
      ok = false; // invalid accelerator on this platform
    }
    (ok ? registered : unavailable).push(accelerator);
  }
  return { supported, enabled: enabled && supported, registered, unavailable };
}

export type ShellLocale = 'zh-CN' | 'en';

export function shellLocaleOf(locale: string | null | undefined): ShellLocale {
  return /^zh/i.test(locale ?? '') ? 'zh-CN' : 'en';
}

const LABELS = {
  'zh-CN': {
    tooltip: 'HQPlayer Studio',
    nothing: '当前没有播放',
    play: '播放',
    pause: '暂停',
    previous: '上一首',
    next: '下一首',
    controlOff: '播放控制未开启（设置 → 播放与引擎）',
    mini: '迷你播放器',
    show: '显示 HQPlayer Studio',
    quit: '退出 HQPlayer Studio',
  },
  en: {
    tooltip: 'HQPlayer Studio',
    nothing: 'Nothing playing',
    play: 'Play',
    pause: 'Pause',
    previous: 'Previous',
    next: 'Next',
    controlOff: 'Playback control is off (Settings → Playback & engine)',
    mini: 'Mini Player',
    show: 'Show HQPlayer Studio',
    quit: 'Quit HQPlayer Studio',
  },
} as const;

export interface TrayState {
  locale: ShellLocale;
  title: string | null;
  artist: string | null;
  playing: boolean;
  /** Usable transport commands right now (capability + connection). */
  can: { toggle: boolean; next: boolean; previous: boolean };
  miniOpen: boolean;
}

export type TrayItemId = 'now' | 'toggle' | 'previous' | 'next' | 'mini' | 'show' | 'quit';

export interface TrayItem {
  id?: TrayItemId;
  type?: 'separator' | 'checkbox';
  label?: string;
  enabled?: boolean;
  checked?: boolean;
}

/** Menu model of the tray icon (Electron `Menu.buildFromTemplate` after adding click handlers). */
export function trayMenuModel(s: TrayState): TrayItem[] {
  const L = LABELS[s.locale];
  const now = s.title ? [s.title, s.artist].filter(Boolean).join(' — ') : L.nothing;
  const anyControl = s.can.toggle || s.can.next || s.can.previous;
  return [
    { id: 'now', label: truncate(now, 60), enabled: false },
    ...(!anyControl && s.title !== null ? [{ label: L.controlOff, enabled: false }] : []),
    { type: 'separator' },
    { id: 'toggle', label: s.playing ? L.pause : L.play, enabled: s.can.toggle },
    { id: 'previous', label: L.previous, enabled: s.can.previous },
    { id: 'next', label: L.next, enabled: s.can.next },
    { type: 'separator' },
    { id: 'mini', type: 'checkbox', label: L.mini, checked: s.miniOpen },
    { id: 'show', label: L.show },
    { type: 'separator' },
    { id: 'quit', label: L.quit },
  ];
}

export function trayTooltip(s: Pick<TrayState, 'locale' | 'title' | 'artist'>): string {
  const base = LABELS[s.locale].tooltip;
  // Windows limits tray tooltips to 127 characters.
  return truncate(s.title ? `${base} — ${s.title}` : base, 120);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
