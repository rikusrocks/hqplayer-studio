import { useEffect, useState } from 'react';
import { useStudio } from '../data/StudioProvider';
import { interpolatePosition } from '../format';

/**
 * Smooth playback position between engine status pushes. Re-anchors on every status the
 * engine reports; only extrapolates while the engine says it is playing.
 */
export function useInterpolatedPosition(tickMs = 250): number {
  const { status, statusReceivedAt } = useStudio();
  const playing = status.transport === 'playing' && status.connection === 'connected';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!playing) return;
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [playing, tickMs, statusReceivedAt]);

  return interpolatePosition(status.positionMs, statusReceivedAt, now, playing, status.durationMs);
}
