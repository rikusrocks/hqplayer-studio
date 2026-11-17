import type {
  AdapterKind,
  DspChange,
  DspState,
  EngineCapabilities,
  EngineStatus,
  LiveInputAttempt,
  RepeatMode,
} from '@hqps/contracts';

/**
 * What Studio hands to the engine. `uri` is either a native Windows path
 * (e.g. `D:\Music\Album\01.flac`) or a URI (`file:`, `http:`…) — per SDK 6.0.1 both forms are
 * accepted by `PlaylistAdd`; which one Desktop 6 handles best is a Gate C verification item.
 */
export interface PlayableTrack {
  studioTrackId: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  format?: {
    sampleRate: number | null;
    bitDepth: number | null;
    channels: number | null;
    isDsd: boolean;
  };
}

export interface ReplaceQueueOptions {
  /** Index within `items` that should become current. */
  startIndex: number;
  /** Start playback after loading. Never implied by reconnects — only by explicit user action. */
  autoplay: boolean;
  /** Request album (gapless, whole-album) semantics when the engine supports it. */
  albumMode: boolean;
}

export interface EngineQueueEntry {
  index: number;
  uri: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
}

export interface EngineQueueSnapshot {
  albumMode: boolean | null;
  entries: EngineQueueEntry[];
  /** 0-based index of the engine's current track within `entries`, if known. */
  currentIndex?: number | null;
  currentMatchedBy?: 'uri' | 'index' | 'none';
  /** Verified numbering base of the engine's Status track field (live adapter only). */
  statusTrackBase?: number | null;
}

/** What the engine says about its live inputs (HQPlayer `GetInputs`). */
export interface LiveInputInfo {
  /** `audio:` URIs found anywhere in the reply, in order. */
  uris: string[];
  /** Other names the reply carries (device or input labels), for display. */
  names: string[];
}

export interface LiveInputResult {
  /** The live input that is now playing, or null when none could be started. */
  uri: string | null;
  attempts: LiveInputAttempt[];
}

export type StatusListener = (status: EngineStatus) => void;

/**
 * Domain-level contract for driving HQPlayer. This is deliberately NOT a 1:1 mirror of the XML
 * protocol; optional members are capabilities that must also be checked against
 * `getCapabilities()` at runtime. Mock and Live adapters implement the same contract.
 */
export interface HQPlayerAdapter {
  readonly kind: AdapterKind;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  getCapabilities(): Promise<EngineCapabilities>;
  getStatus(): Promise<EngineStatus>;
  /** Subscribe to engine-reported status changes. Returns an unsubscribe function. */
  subscribeStatus(listener: StatusListener): () => void;
  /** Optional: notified when capabilities change at runtime (e.g. HQPlayer volume unlocked). */
  subscribeCapabilities?(listener: () => void): () => void;

  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;

  seek?(positionMs: number): Promise<void>;
  setVolume?(volumeDb: number): Promise<void>;
  replaceQueue?(items: PlayableTrack[], options: ReplaceQueueOptions): Promise<void>;
  appendToQueue?(items: PlayableTrack[]): Promise<void>;
  /** Insert right after the current engine track (Play Next). */
  insertNext?(items: PlayableTrack[]): Promise<void>;
  removeFromQueue?(engineIndex: number): Promise<void>;
  clearQueue?(): Promise<void>;
  selectIndex?(index: number, autoplay: boolean): Promise<void>;
  getEngineQueue?(): Promise<EngineQueueSnapshot>;
  setRepeat?(mode: RepeatMode): Promise<void>;
  setRandom?(on: boolean): Promise<void>;
  getDspState?(): Promise<DspState>;
  /** Optional: change mode / filters / modulator / rate / toggles (live adapter, opt-in). */
  setDsp?(change: DspChange): Promise<DspState>;
  /** Optional, read-only: the live inputs the engine lists. */
  getLiveInputs?(): Promise<LiveInputInfo>;
  /**
   * Optional (opt-in): replace the engine's playlist with ONE live-input entry and play it.
   * The URIs are tried in order; with none playable the playlist is left empty and stopped.
   */
  playLiveInput?(uris: string[]): Promise<LiveInputResult>;
}
