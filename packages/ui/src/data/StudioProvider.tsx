import {
  StudioApiError,
  StudioRealtime,
  createStudioClient,
  type RealtimeState,
  type StudioClient,
} from '@hqps/api-client';
import {
  canUse,
  disconnectedStatus,
  emptyQueue,
  type EngineCapabilities,
  type EngineCapabilityKey,
  type EngineStatus,
  type LibraryStats,
  type PlaylistDetail,
  type PlaylistSummary,
  type QueueMode,
  type QueueSource,
  type QueueState,
  type ScanJob,
  type ServerInfo,
  type StudioEvent,
  type TransportAction,
} from '@hqps/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { hasMessage, useT, type Translate } from '../i18n/I18nProvider';
import { useToasts } from './toasts';

export type PendingKey =
  'transport' | 'seek' | 'volume' | 'queue' | 'playlist' | 'takeover' | 'follow';

export interface StudioContextValue {
  client: StudioClient;
  server: ServerInfo | null;
  /** Last engine-reported status. Never optimistic. */
  status: EngineStatus;
  /** Local `Date.now()` when `status` arrived — the anchor for progress interpolation. */
  statusReceivedAt: number;
  capabilities: EngineCapabilities | null;
  queue: QueueState;
  realtime: RealtimeState;
  playlists: PlaylistSummary[];
  scanJobs: ScanJob[];
  stats: LibraryStats | null;
  /** Bumps when library content may have changed — views refetch on change. */
  libraryVersion: number;
  playlistsVersion: number;
  pending: ReadonlySet<PendingKey>;
  isMock: boolean;
  serverReachable: boolean;
  engineConnected: boolean;

  /** Run an API call; errors become toasts. Resolves undefined on failure. */
  run: <T>(
    fn: () => Promise<T>,
    opts?: { pending?: PendingKey; success?: string },
  ) => Promise<T | undefined>;
  transport: (action: TransportAction) => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  setVolume: (volumeDb: number) => Promise<void>;
  playTracks: (
    trackIds: string[],
    opts?: { startIndex?: number; source?: QueueSource; mode?: QueueMode },
  ) => Promise<void>;
  playAlbum: (albumId: string, startTrackId?: string) => Promise<void>;
  playPlaylist: (playlistId: string, startItemId?: string) => Promise<void>;
  queueAdd: (trackIds: string[], position: 'next' | 'end') => Promise<void>;
  queueRemove: (itemIds: string[]) => Promise<void>;
  queueJump: (index: number) => Promise<void>;
  queueClear: () => Promise<void>;
  queueTakeover: () => Promise<void>;
  /** Make Studio follow HQPlayer (read-only towards the engine). */
  queueFollow: () => Promise<void>;
  addToPlaylist: (
    playlist: Pick<PlaylistSummary, 'id' | 'name'>,
    trackIds: string[],
  ) => Promise<void>;
  createPlaylist: (name: string, trackIds?: string[]) => Promise<PlaylistDetail | undefined>;
  refreshPlaylists: () => Promise<void>;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function describeError(err: unknown, t: Translate): string {
  if (err instanceof StudioApiError) {
    if (err.code === 'network_error') return t('errors.network');
    return t('errors.generic', { message: err.message });
  }
  return t('errors.generic', { message: err instanceof Error ? err.message : String(err) });
}

export interface StudioProviderProps {
  children: ReactNode;
  /** Defaults to same-origin. */
  baseUrl?: string;
}

export function StudioProvider({ children, baseUrl = '' }: StudioProviderProps) {
  const t = useT();
  const toasts = useToasts();
  const client = useMemo(() => createStudioClient({ baseUrl }), [baseUrl]);

  const [server, setServer] = useState<ServerInfo | null>(null);
  const [status, setStatus] = useState<EngineStatus>(() => disconnectedStatus());
  const [statusReceivedAt, setStatusReceivedAt] = useState(() => Date.now());
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null);
  const [queue, setQueue] = useState<QueueState>(() => emptyQueue());
  const [realtime, setRealtime] = useState<RealtimeState>('connecting');
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [scanJobsById, setScanJobsById] = useState<Record<string, ScanJob>>({});
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [playlistsVersion, setPlaylistsVersion] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<PendingKey>>(() => new Set());

  // Keep monotonic serial/version checks against the latest value, not a stale closure.
  const statusRef = useRef(status);
  const queueRef = useRef(queue);
  // Notices are translated with the current locale without reconnecting the event stream.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const applyStatus = useCallback((next: EngineStatus, reset = false) => {
    if (!reset && next.serial < statusRef.current.serial) return;
    statusRef.current = next;
    setStatus(next);
    setStatusReceivedAt(Date.now());
  }, []);

  const applyQueue = useCallback((next: QueueState, reset = false) => {
    if (!reset && next.version < queueRef.current.version) return;
    queueRef.current = next;
    setQueue(next);
  }, []);

  const refreshPlaylists = useCallback(async () => {
    try {
      setPlaylists(await client.playlists.list());
    } catch {
      // surfaced elsewhere (connection badge); keep the last list
    }
  }, [client]);

  const refreshScanJobs = useCallback(async () => {
    try {
      const jobs = await client.library.scanJobs();
      setScanJobsById(Object.fromEntries(jobs.map((j) => [j.id, j])));
    } catch {
      // ignore
    }
  }, [client]);

  // Realtime subscription: `hello` carries the full state on every (re)connect.
  useEffect(() => {
    const rt = new StudioRealtime({ url: client.eventsUrl() });
    const offState = rt.onState(setRealtime);
    const offEvent = rt.onEvent((event: StudioEvent) => {
      switch (event.type) {
        case 'hello':
          setServer(event.server);
          applyStatus(event.status, true);
          setCapabilities(event.capabilities);
          applyQueue(event.queue, true);
          setLibraryVersion((v) => v + 1);
          void refreshPlaylists();
          void refreshScanJobs();
          client.library
            .stats()
            .then(setStats)
            .catch(() => undefined);
          break;
        case 'engine.status':
          applyStatus(event.status);
          break;
        case 'engine.capabilities':
          setCapabilities(event.capabilities);
          break;
        case 'queue.changed':
          applyQueue(event.queue);
          break;
        case 'playlists.changed':
          setPlaylistsVersion((v) => v + 1);
          void refreshPlaylists();
          break;
        case 'library.changed':
          setStats(event.stats);
          setLibraryVersion((v) => v + 1);
          break;
        case 'library.scan':
          setScanJobsById((jobs) => ({ ...jobs, [event.job.id]: event.job }));
          break;
        case 'notice': {
          const key = `notice.${event.code}`;
          toasts.push(
            event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'info',
            hasMessage(key) ? tRef.current(key, event.params) : event.message,
          );
          break;
        }
      }
    });
    rt.start();
    return () => {
      offEvent();
      offState();
      rt.stop();
    };
  }, [client, applyStatus, applyQueue, refreshPlaylists, refreshScanJobs, toasts]);

  const run = useCallback(
    async <T,>(
      fn: () => Promise<T>,
      opts: { pending?: PendingKey; success?: string } = {},
    ): Promise<T | undefined> => {
      const key = opts.pending;
      if (key) setPending((s) => new Set(s).add(key));
      try {
        const result = await fn();
        if (opts.success) toasts.push('success', opts.success);
        return result;
      } catch (err) {
        toasts.push('error', describeError(err, t));
        return undefined;
      } finally {
        if (key)
          setPending((s) => {
            const n = new Set(s);
            n.delete(key);
            return n;
          });
      }
    },
    [t, toasts],
  );

  const value = useMemo<StudioContextValue>(() => {
    const engineCmd = async (fn: () => Promise<{ status: EngineStatus }>, key: PendingKey) => {
      const res = await run(fn, { pending: key });
      // The response carries the engine's own status after the command — not an optimistic guess.
      if (res) applyStatus(res.status);
    };
    const queueCmd = async (fn: () => Promise<QueueState>, success?: string) => {
      const res = await run(fn, { pending: 'queue', success });
      if (res) applyQueue(res);
    };
    return {
      client,
      server,
      status,
      statusReceivedAt,
      capabilities,
      queue,
      realtime,
      playlists,
      scanJobs: Object.values(scanJobsById).sort(
        (a, b) =>
          (b.startedAt ?? Number.MAX_SAFE_INTEGER) - (a.startedAt ?? Number.MAX_SAFE_INTEGER),
      ),
      stats,
      libraryVersion,
      playlistsVersion,
      pending,
      isMock: server?.adapter === 'mock' || capabilities?.adapter === 'mock',
      serverReachable: realtime === 'open',
      engineConnected: realtime === 'open' && status.connection === 'connected',
      run,
      transport: (action) => engineCmd(() => client.engine.transport(action), 'transport'),
      seek: (positionMs) => engineCmd(() => client.engine.seek(positionMs), 'seek'),
      setVolume: (volumeDb) => engineCmd(() => client.engine.volume(volumeDb), 'volume'),
      playTracks: (trackIds, opts = {}) =>
        queueCmd(() =>
          client.queue.replace({
            trackIds,
            startIndex: opts.startIndex ?? 0,
            source: opts.source,
            mode: opts.mode,
            autoplay: true,
          }),
        ),
      playAlbum: (albumId, startTrackId) =>
        queueCmd(() => client.playback.album(albumId, startTrackId)),
      playPlaylist: (playlistId, startItemId) =>
        queueCmd(() => client.playback.playlist(playlistId, startItemId)),
      queueAdd: (trackIds, position) =>
        queueCmd(
          () => client.queue.add({ trackIds, position }),
          position === 'next' ? t('actions.willPlayNext') : t('actions.addedToQueue'),
        ),
      queueRemove: (itemIds) => queueCmd(() => client.queue.remove(itemIds)),
      queueJump: (index) => queueCmd(() => client.queue.jump(index)),
      queueClear: () => queueCmd(() => client.queue.clear()),
      queueTakeover: async () => {
        const res = await run(() => client.queue.takeover(), { pending: 'takeover' });
        if (res) applyQueue(res);
      },
      queueFollow: async () => {
        const res = await run(() => client.queue.follow(), { pending: 'follow' });
        if (res) applyQueue(res);
      },
      addToPlaylist: async (playlist, trackIds) => {
        await run(() => client.playlists.addItems(playlist.id, { trackIds }), {
          pending: 'playlist',
          success: t('actions.addedToPlaylist', { name: playlist.name }),
        });
      },
      createPlaylist: async (name, trackIds) => {
        const created = await run(() => client.playlists.create({ name, trackIds }), {
          pending: 'playlist',
          success: t('playlist.created', { name }),
        });
        if (created) void refreshPlaylists();
        return created;
      },
      refreshPlaylists,
    };
  }, [
    client,
    server,
    status,
    statusReceivedAt,
    capabilities,
    queue,
    realtime,
    playlists,
    scanJobsById,
    stats,
    libraryVersion,
    playlistsVersion,
    pending,
    run,
    applyStatus,
    applyQueue,
    refreshPlaylists,
    t,
  ]);

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio must be used inside <StudioProvider>');
  return ctx;
}

/**
 * Returns a function that explains why a capability-gated control is disabled,
 * or null when it may be used right now.
 */
export function useCapabilityGate(): (key: EngineCapabilityKey) => string | null {
  const { capabilities, serverReachable, engineConnected } = useStudio();
  const t = useT();
  return useCallback(
    (key: EngineCapabilityKey) => {
      if (!serverReachable) return t('engine.serverReason');
      if (!engineConnected) return t('engine.disconnectedReason');
      if (canUse(capabilities, key)) return null;
      const entry = capabilities?.items[key];
      const status = entry?.status;
      if (status === 'unsupported') return t('cap.unsupported');
      if (entry?.note === 'control-disabled') return t('cap.controlDisabled');
      return t('cap.notVerified');
    },
    [capabilities, serverReachable, engineConnected, t],
  );
}
