import { describe, expect, it } from 'vitest';
import { validateBounds } from './window-state';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: 0, width: 2560, height: 1400 };

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
