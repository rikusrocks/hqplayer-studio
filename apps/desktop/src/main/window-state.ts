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

const clampNum = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function overlap(b: Bounds, a: Bounds): number {
  const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
  const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function centreDistance(b: Bounds, a: Bounds): number {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  return dx * dx + dy * dy;
}

/**
 * Move (and if needed shrink) `bounds` so the window lies completely inside one display's work
 * area: the display it overlaps most, else the nearest one. Used when a monitor was unplugged,
 * rearranged or rescaled while Studio ran, and for the small Mini Player, which should never
 * hang off a screen edge.
 */
export function fitToDisplays(bounds: Bounds, workAreas: Bounds[]): Bounds {
  if (workAreas.length === 0) return bounds;
  let best = workAreas[0]!;
  let bestOverlap = -1;
  for (const a of workAreas) {
    const o = overlap(bounds, a);
    if (
      o > bestOverlap ||
      (o === bestOverlap && o === 0 && centreDistance(bounds, a) < centreDistance(bounds, best))
    ) {
      best = a;
      bestOverlap = o;
    }
  }
  if (bestOverlap <= 0) {
    best = workAreas.reduce((n, a) =>
      centreDistance(bounds, a) < centreDistance(bounds, n) ? a : n,
    );
  }
  const width = Math.min(bounds.width, best.width);
  const height = Math.min(bounds.height, best.height);
  return {
    x: Math.round(clampNum(bounds.x, best.x, best.x + best.width - width)),
    y: Math.round(clampNum(bounds.y, best.y, best.y + best.height - height)),
    width,
    height,
  };
}

/**
 * Bounds to open a window with. `main`: keep the saved place if enough of it is visible,
 * otherwise pull it onto a display. `mini`: always fully on one display. Undefined = use the
 * default size/position (nothing saved, or nonsense).
 */
export function restoreBounds(
  saved: Bounds | undefined,
  workAreas: Bounds[],
  kind: 'main' | 'mini',
): Bounds | undefined {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) {
    return undefined;
  }
  if (saved.width < 100 || saved.height < 60) return undefined;
  if (kind === 'main' && validateBounds(saved, workAreas)) return saved;
  return fitToDisplays(saved, workAreas);
}

export function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
