import { describe, expect, it } from 'vitest';
import {
  MEDIA_KEYS,
  normalizeShellPrefs,
  shellLocaleOf,
  syncMediaKeys,
  trayMenuModel,
  trayTooltip,
  type MediaAction,
  type ShortcutRegistrar,
} from './desktop-shell';

function fakeRegistrar(takenByOthers: string[] = []) {
  const mine = new Map<string, () => void>();
  const r: ShortcutRegistrar & { press(accel: string): void; held: () => string[] } = {
    register: (accel, cb) => {
      if (takenByOthers.includes(accel) || mine.has(accel)) return false;
      mine.set(accel, cb);
      return true;
    },
    unregister: (accel) => void mine.delete(accel),
    isRegistered: (accel) => mine.has(accel),
    press: (accel) => mine.get(accel)?.(),
    held: () => [...mine.keys()].sort(),
  };
  return r;
}

describe('shell preferences', () => {
  it('defaults: media keys on, tray off; close-to-tray needs the tray', () => {
    expect(normalizeShellPrefs(undefined)).toEqual({
      mediaKeys: true,
      tray: false,
      closeToTray: false,
    });
    expect(normalizeShellPrefs({ tray: false, closeToTray: true }).closeToTray).toBe(false);
    expect(normalizeShellPrefs({ tray: true, closeToTray: true, mediaKeys: 'yes' })).toEqual({
      mediaKeys: true,
      tray: true,
      closeToTray: true,
    });
  });
  it('maps locales', () => {
    expect(shellLocaleOf('zh-CN')).toBe('zh-CN');
    expect(shellLocaleOf('zh-TW')).toBe('zh-CN');
    expect(shellLocaleOf('en-GB')).toBe('en');
    expect(shellLocaleOf(undefined)).toBe('en');
  });
});

describe('media keys', () => {
  it('registers all four keys and routes them to transport actions', () => {
    const r = fakeRegistrar();
    const actions: MediaAction[] = [];
    const state = syncMediaKeys(r, true, (a) => actions.push(a));
    expect(state).toEqual({
      supported: true,
      enabled: true,
      registered: MEDIA_KEYS.map((k) => k.accelerator),
      unavailable: [],
    });
    r.press('MediaPlayPause');
    r.press('MediaNextTrack');
    r.press('MediaPreviousTrack');
    r.press('MediaStop');
    expect(actions).toEqual(['toggle', 'next', 'previous', 'stop']);
    // idempotent
    expect(syncMediaKeys(r, true, () => undefined).registered).toHaveLength(4);
  });

  it('reports keys another program holds instead of fighting for them', () => {
    const r = fakeRegistrar(['MediaPlayPause']);
    const state = syncMediaKeys(r, true, () => undefined);
    expect(state.unavailable).toEqual(['MediaPlayPause']);
    expect(state.registered).not.toContain('MediaPlayPause');
  });

  it('releases every key when turned off or unsupported', () => {
    const r = fakeRegistrar();
    syncMediaKeys(r, true, () => undefined);
    expect(syncMediaKeys(r, false, () => undefined)).toMatchObject({
      enabled: false,
      registered: [],
    });
    expect(r.held()).toEqual([]);
    expect(syncMediaKeys(r, true, () => undefined, false)).toMatchObject({
      supported: false,
      enabled: false,
      registered: [],
    });
    expect(r.held()).toEqual([]);
  });
});

describe('tray menu', () => {
  const base = {
    locale: 'zh-CN' as const,
    title: '夜の試験曲',
    artist: 'Invented Band',
    playing: true,
    can: { toggle: true, next: true, previous: true },
    miniOpen: false,
  };
  it('shows what plays and offers pause / previous / next / mini / show / quit', () => {
    const items = trayMenuModel(base);
    expect(items.filter((i) => i.id).map((i) => [i.id, i.label, i.enabled ?? true])).toEqual([
      ['now', '夜の試験曲 — Invented Band', false],
      ['toggle', '暂停', true],
      ['previous', '上一首', true],
      ['next', '下一首', true],
      ['mini', '迷你播放器', true],
      ['show', '显示 HQPlayer Studio', true],
      ['quit', '退出 HQPlayer Studio', true],
    ]);
  });
  it('disables controls Studio may not use and says why', () => {
    const items = trayMenuModel({
      ...base,
      locale: 'en',
      playing: false,
      can: { toggle: false, next: false, previous: false },
      miniOpen: true,
    });
    expect(items.find((i) => i.id === 'toggle')).toMatchObject({ label: 'Play', enabled: false });
    expect(items.some((i) => i.label?.startsWith('Playback control is off'))).toBe(true);
    expect(items.find((i) => i.id === 'mini')?.checked).toBe(true);
  });
  it('keeps the tooltip within the Windows limit', () => {
    expect(
      trayTooltip({ locale: 'en', title: 'x'.repeat(300), artist: null }).length,
    ).toBeLessThanOrEqual(120);
    expect(trayTooltip({ locale: 'en', title: null, artist: null })).toBe('HQPlayer Studio');
  });
});
