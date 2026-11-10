import {
  Artwork,
  Icon,
  Spinner,
  useCapabilityGate,
  useInterpolatedPosition,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';

/** Compact now-playing bar shown above the tab bar on non-Now-Playing tabs. */
export function NowStrip() {
  const t = useT();
  const now = useNowPlaying();
  const { status, transport, pending } = useStudio();
  const gate = useCapabilityGate();
  const position = useInterpolatedPosition(1000);
  if (!now.hasTrack) return null;
  const playing = status.transport === 'playing';
  const reason = gate(playing ? 'transport.pause' : 'transport.play');
  const busy = pending.has('transport');
  const pct = status.durationMs ? Math.min(100, (position / status.durationMs) * 100) : 0;

  return (
    <div className="rm-strip">
      <a className="rm-strip__main" href="#/now">
        <Artwork artworkId={now.artworkId} className="rm-strip__art" />
        <span className="rm-strip__text">
          <span className="rm-strip__title">{now.title}</span>
          <span className="rm-strip__artist">{now.artist}</span>
        </span>
      </a>
      <button
        type="button"
        className="hq-icon-btn rm-strip__btn"
        onClick={() => void transport(playing ? 'pause' : 'play')}
        disabled={!!reason || busy}
        title={reason ?? undefined}
        aria-label={t(playing ? 'common.pause' : 'common.play')}
      >
        {busy ? <Spinner size={18} /> : <Icon name={playing ? 'pause' : 'play'} size={24} />}
      </button>
      <button
        type="button"
        className="hq-icon-btn rm-strip__btn"
        onClick={() => void transport('next')}
        disabled={!!gate('transport.next') || busy}
        aria-label={t('common.next')}
      >
        <Icon name="next" size={22} />
      </button>
      <span className="rm-strip__progress" style={{ width: `${pct}%` }} aria-hidden="true" />
    </div>
  );
}
