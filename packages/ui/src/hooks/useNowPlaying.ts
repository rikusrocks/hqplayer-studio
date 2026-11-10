import type { Track } from '@hqps/contracts';
import { useMemo } from 'react';
import { useStudio } from '../data/StudioProvider';

export interface NowPlaying {
  /** True when the engine reports a current track. */
  hasTrack: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  artworkId: string | null;
  /** Matching library track, when the engine track could be mapped to the library. */
  libraryTrack: Track | null;
  /** Source format label of the current track (library tag data preferred). */
  inputLabel: string | null;
  durationMs: number | null;
}

/**
 * What is playing, as reported by the engine (authoritative), enriched with library data
 * (artwork, format label) when the engine track maps to a Studio track.
 */
export function useNowPlaying(): NowPlaying {
  const { status, queue } = useStudio();
  return useMemo(() => {
    const engineTrack = status.track;
    let lib: Track | null = null;
    if (engineTrack?.studioTrackId) {
      lib = queue.items.find((i) => i.track.id === engineTrack.studioTrackId)?.track ?? null;
    }
    if (!lib && engineTrack && queue.sync.state === 'in_sync' && queue.currentIndex !== null) {
      lib = queue.items[queue.currentIndex]?.track ?? null;
    }
    const hasTrack = Boolean(engineTrack) && status.connection === 'connected';
    return {
      hasTrack,
      title: hasTrack ? (engineTrack?.title ?? lib?.title ?? null) : null,
      artist: hasTrack ? (engineTrack?.artist ?? lib?.artist ?? null) : null,
      album: hasTrack ? (engineTrack?.album ?? lib?.album ?? null) : null,
      artworkId: hasTrack ? (lib?.artworkId ?? engineTrack?.artworkId ?? null) : null,
      libraryTrack: hasTrack ? lib : null,
      inputLabel: hasTrack ? (lib?.format.label ?? status.input?.label ?? null) : null,
      durationMs: hasTrack
        ? (status.durationMs ?? engineTrack?.durationMs ?? lib?.durationMs ?? null)
        : null,
    };
  }, [status, queue]);
}
