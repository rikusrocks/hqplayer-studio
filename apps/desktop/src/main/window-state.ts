import { readFileSync, writeFileSync } from 'node:fs';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  main?: Bounds & { maximized?: boolean };
  mini?: Bounds;
  miniAlwaysOnTop?: boolean;
}

export function loadWindowState(file: string): WindowState {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as WindowState;
  } catch {
    return {};
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // non-fatal
  }
}

/**
 * Accept saved bounds only if a meaningful part of the window lies on a currently connected
 * display (monitors may have been unplugged or rearranged since last run).
 */
export function validateBounds(
  bounds: Bounds | undefined,
  workAreas: Bounds[],
  minVisible = 80,
): Bounds | undefined {
  if (!bounds || bounds.width < 100 || bounds.height < 60) return undefined;
  const visible = workAreas.some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= minVisible && h >= Math.min(minVisible, 40);
  });
  return visible ? bounds : undefined;
}
