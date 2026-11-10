import type { DspItem, DspKind, DspLists, DspLiveStatus, DspStateSnapshot } from './session';

/** Which attribute of a list item a number refers to. */
export type Form = 'index' | 'value';

export const DSP_KINDS: readonly DspKind[] = ['mode', 'filter', 'shaper', 'rate'];

export interface StateRef {
  form: Form;
  /** false = could not be told apart on this engine; `form` is then the documented default. */
  certain: boolean;
}

/**
 * Work out whether the number HQPlayer reports in `State` is a list `index` or a list `value`.
 * The name of the active item (from Status `active_*`) decides when both readings are possible.
 */
export function inferStateRef(
  list: readonly DspItem[],
  stateNumber: number | null,
  activeName: string | null,
): StateRef {
  if (stateNumber === null) return { form: 'index', certain: false };
  const byIndex = list.find((i) => i.index === stateNumber);
  const byValue = list.find((i) => i.value === stateNumber);
  if (byIndex && (!byValue || byValue === byIndex)) return { form: 'index', certain: true };
  if (byValue && !byIndex) return { form: 'value', certain: true };
  if (byIndex && byValue && activeName) {
    const i = byIndex.name === activeName;
    const v = byValue.name === activeName;
    if (i && !v) return { form: 'index', certain: true };
    if (v && !i) return { form: 'value', certain: true };
  }
  return { form: 'index', certain: false };
}

export function itemFor(
  list: readonly DspItem[],
  ref: Form,
  stateNumber: number | null,
): DspItem | null {
  if (stateNumber === null) return null;
  return list.find((i) => (ref === 'index' ? i.index : i.value) === stateNumber) ?? null;
}

/** The number `State` is expected to show once `item` is selected. */
export function stateNumberOf(item: DspItem, ref: Form): number | null {
  return ref === 'index' ? item.index : item.value;
}

/**
 * Pick a test target next to the current item. Items whose index differs from their value are
 * preferred, because only those can tell "Set takes the index" from "Set takes the value".
 */
export function pickTarget(
  list: readonly DspItem[],
  current: DspItem,
  prefer?: (item: DspItem) => boolean,
): DspItem | null {
  const others = list.filter((i) => i.index !== current.index);
  if (!others.length) return null;
  const score = (i: DspItem) =>
    (prefer?.(i) ? 0 : 10_000) +
    (i.value !== null && i.value !== i.index ? 0 : 1_000) +
    Math.abs(i.index - current.index);
  return [...others].sort((a, b) => score(a) - score(b) || a.index - b.index)[0] ?? null;
}

/**
 * A rate strictly below the rate in use, in the same rate family (so the DAC is known to accept
 * it). Never returns a higher rate, "auto" (0) or a rate from the other family.
 */
export function pickLowerRate(
  rates: readonly DspItem[],
  current: DspItem,
  activeRate: number | null,
): DspItem | null {
  const inUse = current.value && current.value > 0 ? current.value : (activeRate ?? 0);
  if (!inUse) return null;
  const lower = rates.filter(
    (r) =>
      r.index !== current.index &&
      r.value !== null &&
      r.value > 0 &&
      r.value < inUse &&
      inUse % r.value === 0,
  );
  return lower.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0] ?? null;
}

export function sameList(a: readonly DspItem[], b: readonly DspItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return !!y && x.index === y.index && x.name === y.name && x.value === y.value;
    })
  );
}

export function compareLists(before: DspLists, after: DspLists): Record<DspKind, boolean> {
  return {
    mode: sameList(before.mode, after.mode),
    filter: sameList(before.filter, after.filter),
    shaper: sameList(before.shaper, after.shaper),
    rate: sameList(before.rate, after.rate),
  };
}

export const RESTORE_KEYS = [
  'mode',
  'filter',
  'filter1x',
  'filterNx',
  'shaper',
  'rate',
  'invert',
  'convolution',
  'adaptive',
  'matrixProfile',
] as const;
export type RestoreKey = (typeof RESTORE_KEYS)[number];

/** Settings that differ from the snapshot taken at the start. */
export function diffState(original: DspStateSnapshot, now: DspStateSnapshot): RestoreKey[] {
  return RESTORE_KEYS.filter((k) => original[k] !== now[k]);
}

export interface TimelineSummary {
  samples: number;
  /** Transport states seen, consecutive duplicates removed (e.g. playing → stopped → playing). */
  transports: string[];
  /** Position went back by more than 1.5 s: the track restarted or playback was re-buffered. */
  positionJumpedBack: boolean;
  activeBefore: string | null;
  activeAfter: string | null;
  /** ms after the command until Status showed a different active item (null = never). */
  activeChangedAfterMs: number | null;
}

export function summarizeTimeline(
  samples: readonly DspLiveStatus[],
  sentAt: number,
  key: 'activeShaper' | 'activeFilter',
  before: DspLiveStatus | null,
): TimelineSummary {
  const transports: string[] = [];
  let jumped = false;
  let last: number | null = before?.positionMs ?? null;
  const activeBefore = before?.[key] ?? null;
  let activeAfter = activeBefore;
  let changedAt: number | null = null;
  for (const s of samples) {
    if (transports[transports.length - 1] !== s.transport) transports.push(s.transport);
    if (s.positionMs !== null) {
      if (last !== null && s.positionMs < last - 1500) jumped = true;
      last = s.positionMs;
    }
    const active = s[key];
    if (active !== null && active !== activeAfter) {
      activeAfter = active;
      if (changedAt === null) changedAt = Math.max(0, s.receivedAt - sentAt);
    }
  }
  return {
    samples: samples.length,
    transports,
    positionJumpedBack: jumped,
    activeBefore,
    activeAfter,
    activeChangedAfterMs: changedAt,
  };
}

export function describeItem(item: DspItem | null): string {
  if (!item) return '?';
  return `[${item.index}] ${item.name || '(no name)'}`;
}

/** Format a rate list entry for people: 24576000 → "24.576 MHz", 0 → "auto". */
export function describeRate(item: DspItem | null): string {
  if (!item) return '?';
  const hz = item.value ?? 0;
  if (hz === 0) return `[${item.index}] auto`;
  return hz >= 1_000_000
    ? `[${item.index}] ${(hz / 1_000_000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} MHz`
    : `[${item.index}] ${(hz / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
}
