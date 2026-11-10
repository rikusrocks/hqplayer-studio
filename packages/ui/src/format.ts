import type { AudioFormat } from '@hqps/contracts';

export type Locale = 'zh-CN' | 'en';

/** "3:07", "1:02:03". Null/negative → "--:--". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Long-form total, e.g. zh "1 小时 12 分钟", en "1 hr 12 min". */
export function formatLongDuration(ms: number | null | undefined, locale: Locale): string {
  if (!ms || ms < 0) return locale === 'zh-CN' ? '0 分钟' : '0 min';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (locale === 'zh-CN') {
    if (h > 0) return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
    return `${Math.max(1, m)} 分钟`;
  }
  if (h > 0) return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  return `${Math.max(1, m)} min`;
}

export function formatDate(epochMs: number | null | undefined, locale: Locale): string {
  if (!epochMs) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString();
  }
}

export function formatNumber(n: number, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale).format(n);
  } catch {
    return String(n);
  }
}

export function formatVolume(db: number | null | undefined): string {
  if (db === null || db === undefined || !Number.isFinite(db)) return '— dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** Compact sample-rate label for an engine-reported audio format. */
export function audioFormatLabel(format: AudioFormat | null | undefined): string | null {
  if (!format) return null;
  return format.label;
}

/** "FLAC 24/96 → DSD512" (either side optional). */
export function signalPathLabel(
  inputLabel: string | null | undefined,
  output: AudioFormat | null | undefined,
): string | null {
  const out = audioFormatLabel(output);
  if (inputLabel && out) return `${inputLabel} → ${out}`;
  return inputLabel || out || null;
}

/** Clamp helper used by sliders. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Position shown in the UI between engine status pushes. The engine stays authoritative:
 * we only extrapolate from its last report while it says "playing", and never past the end.
 */
export function interpolatePosition(
  anchorPositionMs: number,
  anchorAtMs: number,
  nowMs: number,
  playing: boolean,
  durationMs: number | null,
): number {
  if (!playing) return anchorPositionMs;
  const elapsed = Math.max(0, nowMs - anchorAtMs);
  const pos = anchorPositionMs + elapsed;
  return durationMs !== null && durationMs > 0 ? Math.min(pos, durationMs) : pos;
}
