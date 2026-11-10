import {
  ConnectionBadge,
  MockBadge,
  signalPathLabel,
  useNowPlaying,
  useStudio,
  useT,
} from '@hqps/ui';

/** Thin bottom strip: engine connection, signal path and a DSP summary (when reported). */
export function StatusBar() {
  const t = useT();
  const { status, realtime, capabilities } = useStudio();
  const now = useNowPlaying();
  const path = now.hasTrack ? signalPathLabel(now.inputLabel, status.output) : null;
  const dsp = status.dsp;
  const dspText = dsp ? [dsp.mode, dsp.filter, dsp.shaper].filter(Boolean).join(' · ') : null;
  const engine = capabilities?.engine;

  return (
    <div className="statusbar" role="contentinfo">
      <ConnectionBadge />
      <MockBadge />
      {engine && (
        <span className="statusbar__item hq-muted">
          {engine.product}
          {engine.version ? ` ${engine.version}` : ''}
        </span>
      )}
      {path && (
        <span className="statusbar__item" title={t('settings.signalPath')}>
          {path}
        </span>
      )}
      {dspText && (
        <span className="statusbar__item hq-muted" title={t('settings.dsp')}>
          {dspText}
        </span>
      )}
      <span className="statusbar__spacer" />
      <span className="statusbar__item hq-muted" title={t('diag.realtime')}>
        {t('diag.realtime')}: {t(`realtime.${realtime}`)}
      </span>
    </div>
  );
}
