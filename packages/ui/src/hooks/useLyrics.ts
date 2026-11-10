import { MAX_LYRICS_OFFSET_MS, type TrackLyrics } from '@hqps/contracts';
import { activeLineIndex } from '@hqps/lyrics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../data/StudioProvider';
import { useInterpolatedPosition } from './useInterpolatedPosition';

export interface LyricsState {
  lyrics: TrackLyrics | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
  /** Change the per-track calibration (saved after a short pause, shared with other clients). */
  setOffset: (offsetMs: number) => void;
}

const clampOffset = (ms: number) =>
  Math.max(-MAX_LYRICS_OFFSET_MS, Math.min(MAX_LYRICS_OFFSET_MS, Math.round(ms)));

/**
 * Lyrics of a library track. Refetches when the track changes, when another client changes the
 * stored lyrics (`lyrics.changed`), and — when LRCLIB was unavailable — once the server's back-off
 * has passed (the server itself rate-limits; this never polls faster than it allows).
 */
export function useTrackLyrics(trackId: string | null): LyricsState {
  const { client, lyricsVersion, run } = useStudio();
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOffset = useRef<number | null>(null);

  useEffect(() => {
    if (!trackId) {
      setLyrics(null);
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    client.lyrics
      .get(trackId)
      .then((res) => {
        if (!alive) return;
        // Keep a calibration the user is still adjusting.
        setLyrics(
          pendingOffset.current !== null ? { ...res, offsetMs: pendingOffset.current } : res,
        );
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, trackId, lyricsVersion, nonce]);

  // Track changed: drop the previous track's lyrics immediately.
  useEffect(() => {
    pendingOffset.current = null;
    setLyrics((l) => (l && l.trackId !== trackId ? null : l));
  }, [trackId]);

  useEffect(() => {
    if (lyrics?.state !== 'unavailable') return;
    const wait = Math.max(5000, (lyrics.online.retryAfterMs ?? 30_000) + 500);
    const id = setTimeout(() => setNonce((n) => n + 1), wait);
    return () => clearTimeout(id);
  }, [lyrics]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const setOffset = useCallback(
    (offsetMs: number) => {
      if (!trackId) return;
      const value = clampOffset(offsetMs);
      pendingOffset.current = value;
      setLyrics((l) => (l && l.trackId === trackId ? { ...l, offsetMs: value } : l));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // Errors become toasts; the lyrics themselves stay on screen.
        void run(() => client.lyrics.setOffset(trackId, value)).then((res) => {
          if (pendingOffset.current === value) pendingOffset.current = null;
          if (res) setLyrics((l) => (l && l.trackId === trackId ? res : l));
        });
      }, 400);
    },
    [client, run, trackId],
  );

  return { lyrics, loading, error, reload: () => setNonce((n) => n + 1), setOffset };
}

/** Index of the line being heard now (audible position, user calibration applied). */
export function useActiveLyricIndex(lyrics: TrackLyrics | null): number {
  const position = useInterpolatedPosition(150);
  const lines = lyrics?.kind === 'synced' ? lyrics.lines : null;
  return useMemo(
    () => (lines ? activeLineIndex(lines, position, lyrics?.offsetMs ?? 0) : -1),
    [lines, position, lyrics?.offsetMs],
  );
}
