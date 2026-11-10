import { useState, type CSSProperties } from 'react';
import { useCapabilityGate, useStudio } from '../data/StudioProvider';
import { clamp, formatDuration, formatVolume } from '../format';
import { useInterpolatedPosition } from '../hooks/useInterpolatedPosition';
import { useT } from '../i18n/I18nProvider';
import { Icon } from './Icon';
import { Spinner } from './basics';

type Size = 'sm' | 'md' | 'lg';

/**
 * Previous / Play-Pause / Next. Buttons are disabled with an explanation whenever the engine
 * is unreachable or the capability has not been verified. While a command is in flight the
 * play button shows a spinner — the icon only flips when HQPlayer reports the new state.
 */
export function TransportControls({
  size = 'md',
  showStop = false,
}: {
  size?: Size;
  showStop?: boolean;
}) {
  const { status, transport, pending } = useStudio();
  const gate = useCapabilityGate();
  const t = useT();
  const playing = status.transport === 'playing';
  const toggleKey = playing ? 'transport.pause' : 'transport.play';
  const toggleReason = gate(toggleKey);
  const prevReason = gate('transport.previous');
  const nextReason = gate('transport.next');
  const stopReason = gate('transport.stop');
  const busy = pending.has('transport');
  const iconSize = size === 'lg' ? 30 : size === 'md' ? 22 : 18;

  return (
    <div className={`hq-transport hq-transport--${size}`}>
      <button
        type="button"
        className="hq-icon-btn"
        onClick={() => void transport('previous')}
        disabled={!!prevReason || busy}
        title={prevReason ?? t('common.previous')}
        aria-label={t('common.previous')}
      >
        <Icon name="previous" size={iconSize} />
      </button>
      <button
        type="button"
        className="hq-icon-btn hq-transport__main"
        onClick={() => void transport(playing ? 'pause' : 'play')}
        disabled={!!toggleReason || busy}
        title={
          busy
            ? t('player.waitingEngine')
            : (toggleReason ?? t(playing ? 'common.pause' : 'common.play'))
        }
        aria-label={t(playing ? 'common.pause' : 'common.play')}
        aria-busy={busy}
      >
        {busy ? (
          <Spinner size={iconSize - 4} label={t('player.waitingEngine')} />
        ) : (
          <Icon name={playing ? 'pause' : 'play'} size={iconSize} />
        )}
      </button>
      <button
        type="button"
        className="hq-icon-btn"
        onClick={() => void transport('next')}
        disabled={!!nextReason || busy}
        title={nextReason ?? t('common.next')}
        aria-label={t('common.next')}
      >
        <Icon name="next" size={iconSize} />
      </button>
      {showStop && (
        <button
          type="button"
          className="hq-icon-btn"
          onClick={() => void transport('stop')}
          disabled={!!stopReason || busy}
          title={stopReason ?? t('common.stop')}
          aria-label={t('common.stop')}
        >
          <Icon name="stop" size={iconSize - 4} />
        </button>
      )}
    </div>
  );
}

/** Seekable progress bar driven by the interpolated engine position. */
export function ProgressBar({
  showTimes = true,
  className,
}: {
  showTimes?: boolean;
  className?: string;
}) {
  const { status, seek, pending } = useStudio();
  const gate = useCapabilityGate();
  const t = useT();
  const position = useInterpolatedPosition();
  const [drag, setDrag] = useState<number | null>(null);
  const duration = status.durationMs ?? 0;
  const hasTrack = Boolean(status.track) && duration > 0;
  const seekReason = gate('transport.seek');
  const value = drag ?? clamp(position, 0, duration || 0);
  const pct = duration > 0 ? (value / duration) * 100 : 0;
  const disabled = !hasTrack || !!seekReason || pending.has('seek');

  const commit = () => {
    if (drag === null) return;
    const target = drag;
    setDrag(null);
    void seek(target);
  };

  return (
    <div className={`hq-progress${className ? ` ${className}` : ''}`}>
      {showTimes && (
        <span className="hq-progress__time">{formatDuration(hasTrack ? value : null)}</span>
      )}
      <input
        type="range"
        className="hq-range"
        min={0}
        max={Math.max(1, duration)}
        step={1000}
        value={value}
        disabled={disabled}
        title={seekReason ?? t('player.seek')}
        aria-label={t('player.seek')}
        aria-valuetext={`${formatDuration(value)} / ${formatDuration(duration)}`}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      {showTimes && (
        <span className="hq-progress__time hq-progress__time--end">
          {formatDuration(hasTrack ? duration : null)}
        </span>
      )}
    </div>
  );
}

/** Volume in dB (HQPlayer digital volume). Only rendered when the engine can report volume. */
export function VolumeControl({ className }: { className?: string }) {
  const { status, setVolume, capabilities } = useStudio();
  const gate = useCapabilityGate();
  const t = useT();
  const [drag, setDrag] = useState<number | null>(null);
  if (!capabilities?.items['volume.read']?.usable) return null;
  const range = status.volumeRange ?? { min: -60, max: 0 };
  const current = status.volumeDb ?? range.min;
  const value = drag ?? clamp(current, range.min, range.max);
  const pct = ((value - range.min) / Math.max(1e-6, range.max - range.min)) * 100;
  const reason = gate('volume.set');

  const commit = () => {
    if (drag === null) return;
    const target = drag;
    setDrag(null);
    void setVolume(target);
  };

  return (
    <div className={`hq-volume${className ? ` ${className}` : ''}`}>
      <Icon name={value <= range.min ? 'volumeMute' : 'volume'} size={18} />
      <input
        type="range"
        className="hq-range hq-range--volume"
        min={range.min}
        max={range.max}
        step={0.5}
        value={value}
        disabled={!!reason || status.volumeDb === null}
        title={reason ?? `${t('player.volume')} ${formatVolume(status.volumeDb)}`}
        aria-label={t('player.volume')}
        aria-valuetext={formatVolume(value)}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="hq-volume__value">{formatVolume(drag ?? status.volumeDb)}</span>
    </div>
  );
}
