import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fitToDisplays,
  loadWindowState,
  restoreBounds,
  saveWindowState,
  validateBounds,
} from './window-state';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: 0, width: 2560, height: 1400 };
const left = { x: -1280, y: 200, width: 1280, height: 984 };

describe('validateBounds (multi-monitor restore)', () => {
  it('keeps bounds that are visible on a connected display', () => {
    const b = { x: 2000, y: 100, width: 380, height: 132 };
    expect(validateBounds(b, [primary, secondary])).toEqual(b);
  });
  it('drops bounds that were on a monitor that is now disconnected', () => {
    expect(validateBounds({ x: 2000, y: 100, width: 380, height: 132 }, [primary])).toBeUndefined();
  });
  it('drops windows that are almost entirely off-screen or degenerate', () => {
    expect(validateBounds({ x: 1900, y: 100, width: 380, height: 132 }, [primary])).toBeUndefined();
    expect(validateBounds({ x: 10, y: 10, width: 20, height: 20 }, [primary])).toBeUndefined();
    expect(validateBounds(undefined, [primary])).toBeUndefined();
  });
});

describe('fitToDisplays (monitors changed)', () => {
  it('brings a Mini Player from an unplugged monitor onto the remaining one, same size', () => {
    const mini = { x: 3900, y: 1200, width: 380, height: 132 };
    expect(fitToDisplays(mini, [primary])).toEqual({ x: 1540, y: 908, width: 380, height: 132 });
  });
  it('pulls a window hanging off an edge fully onto the display it mostly covers', () => {
    expect(fitToDisplays({ x: 1800, y: -40, width: 380, height: 132 }, [primary])).toEqual({
      x: 1540,
      y: 0,
      width: 380,
      height: 132,
    });
    // mostly on the secondary monitor → stays there
    expect(
      fitToDisplays({ x: 1850, y: 50, width: 380, height: 132 }, [primary, secondary]),
    ).toEqual({ x: 1920, y: 50, width: 380, height: 132 });
  });
  it('shrinks a window that no longer fits (smaller monitor / higher scaling)', () => {
    expect(fitToDisplays({ x: 0, y: 0, width: 2560, height: 1400 }, [primary])).toEqual(primary);
  });
  it('picks the nearest display for a window that overlaps none (negative coordinates too)', () => {
    expect(fitToDisplays({ x: -2000, y: 300, width: 400, height: 140 }, [primary, left])).toEqual({
      x: -1280,
      y: 300,
      width: 400,
      height: 140,
    });
  });
  it('leaves bounds alone when no display information is available', () => {
    const b = { x: 5, y: 5, width: 300, height: 120 };
    expect(fitToDisplays(b, [])).toEqual(b);
  });
});

describe('restoreBounds', () => {
  it('main window keeps a partly visible place; the mini player is always fully on screen', () => {
    const b = { x: 1700, y: 100, width: 800, height: 600 };
    expect(restoreBounds(b, [primary], 'main')).toEqual(b);
    expect(restoreBounds({ x: 1700, y: 100, width: 380, height: 132 }, [primary], 'mini')).toEqual({
      x: 1540,
      y: 100,
      width: 380,
      height: 132,
    });
  });
  it('moves a main window from a disconnected monitor instead of forgetting its size', () => {
    expect(restoreBounds({ x: 2100, y: 80, width: 1400, height: 900 }, [primary], 'main')).toEqual({
      x: 520,
      y: 80,
      width: 1400,
      height: 900,
    });
  });
  it('ignores nonsense from a damaged state file', () => {
    expect(
      restoreBounds({ x: Number.NaN, y: 0, width: 400, height: 200 }, [primary], 'mini'),
    ).toBeUndefined();
    expect(restoreBounds({ x: 0, y: 0, width: 50, height: 20 }, [primary], 'main')).toBeUndefined();
    expect(restoreBounds(undefined, [primary], 'mini')).toBeUndefined();
  });
});

describe('window-state.json', () => {
  it('round-trips and survives a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hqps-winstate-'));
    try {
      const file = join(dir, 'window-state.json');
      expect(loadWindowState(file)).toEqual({});
      saveWindowState(file, {
        mini: { x: 1, y: 2, width: 380, height: 132 },
        miniAlwaysOnTop: false,
      });
      expect(loadWindowState(file)).toEqual({
        mini: { x: 1, y: 2, width: 380, height: 132 },
        miniAlwaysOnTop: false,
      });
      writeFileSync(file, '{oops');
      expect(loadWindowState(file)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
