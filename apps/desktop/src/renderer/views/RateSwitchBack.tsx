import { useDialogs, useI18n, useStudio } from '@hqps/ui';
import { useEffect, useRef } from 'react';
import { rateLabel } from './DspControls';

/**
 * "Switch the output rate back?" — asked once when local music plays at the output rate Studio
 * chose for Apple Music, and the rate before Apple Music was different. Core decides when (and
 * remembers it across a restart); this only shows the question and sends the answer.
 */
export function useRateSwitchBack(): void {
  const { t } = useI18n();
  const { appleMusic, client, run } = useStudio();
  const { confirm } = useDialogs();
  const asking = useRef<string | null>(null);
  const offer = appleMusic?.rateSwitchBack ?? null;
  const key = offer ? `${offer.fromRate}>${offer.toRate}` : null;

  useEffect(() => {
    if (!offer || !key || asking.current === key) return;
    asking.current = key;
    const from = rateLabel(offer.fromRate, t);
    const to = rateLabel(offer.toRate, t);
    void confirm({
      title: t('am.switchBack.title'),
      message: t('am.switchBack.message', { from, to }),
      confirmLabel: t('am.switchBack.accept', { to }),
      cancelLabel: t('am.switchBack.keep', { from }),
    })
      .then((accept) =>
        run(() => client.appleMusic.rateSwitchBack(accept), {
          success: accept ? t('am.switchBack.done', { to }) : undefined,
        }),
      )
      .finally(() => {
        asking.current = null;
      });
  }, [offer, key, t, confirm, run, client]);
}
