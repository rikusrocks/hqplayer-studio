import {
  formatLabel,
  type AudioFormat,
  type EngineStatus,
  type RepeatMode,
  type TransportState,
} from '@hqps/contracts';
import { attrFloat, attrInt, attrStr, unescapeHqpText, type XmlElement } from './xml';

/**
 * Mapping of SDK 6.0.1 `Status` / `State` response attributes to Studio's EngineStatus.
 * Attribute names come from ControlInterface::onReadyRead. Units marked "assumed" are pending
 * Gate B verification on Desktop 6 (see docs/protocol-capabilities.md).
 */

/** SDK enum clControlInterface::State. */
export function mapTransport(state: number | null): TransportState {
  switch (state) {
    case 0:
      return 'stopped';
    case 1:
      return 'paused';
    case 2:
      return 'playing';
    case 3:
      return 'stopping';
    default:
      return 'unknown';
  }
}

/** SDK enum clControlInterface::Repeat. */
export function mapRepeat(value: number | null): RepeatMode | null {
  if (value === 0) return 'none';
  if (value === 1) return 'single';
  if (value === 2) return 'all';
  return null;
}

export function repeatToSdk(mode: RepeatMode): number {
  return mode === 'none' ? 0 : mode === 'single' ? 1 : 2;
}

function text(el: XmlElement | undefined, name: string): string | null {
  const v = attrStr(el, name);
  return v === null ? null : unescapeHqpText(v);
}

export type MappedStatus = Omit<EngineStatus, 'serial' | 'connection' | 'lastError'>;

/**
 * HQPlayer playlist indexes are 1-based: PlaylistItem.index ran 1..52 on Desktop 6 / engine 6.1.0
 * (probe 2026-11-10). Status `track` is assumed to use the same base, with 0 meaning "no current
 * track" (it was 0 while stopped) — to be confirmed during playback. Studio uses 0-based indexes.
 */
export const ENGINE_INDEX_BASE = 1;

export function toStudioIndex(engineIndex: number | null): number | null {
  return engineIndex !== null && engineIndex >= ENGINE_INDEX_BASE
    ? engineIndex - ENGINE_INDEX_BASE
    : null;
}

export function toEngineIndex(studioIndex: number): number {
  return studioIndex + ENGINE_INDEX_BASE;
}

export function mapStatusDocument(doc: XmlElement, now = Date.now()): MappedStatus {
  const meta = doc.children.find((c) => c.name === 'metadata');

  // position/length are doubles in the SDK; assumed seconds. Fall back to min/sec.
  const position = attrFloat(doc, 'position');
  const positionMs =
    position !== null
      ? Math.max(0, Math.round(position * 1000))
      : ((attrInt(doc, 'min') ?? 0) * 60 + (attrInt(doc, 'sec') ?? 0)) * 1000;
  const length = attrFloat(doc, 'length');
  const durationMs = length !== null && length > 0 ? Math.round(length * 1000) : null;

  let input: AudioFormat | null = null;
  if (meta) {
    const rate = attrInt(meta, 'samplerate');
    const sdm = attrInt(meta, 'sdm') === 1;
    const bits = attrInt(meta, 'bits');
    if (rate) {
      const kind = sdm ? 'DSD' : 'PCM';
      input = {
        kind,
        sampleRate: rate,
        bits: sdm ? 1 : bits,
        channels: attrInt(meta, 'channels'),
        label: formatLabel(kind, rate, sdm ? null : bits),
      };
    }
  }

  const activeMode = attrStr(doc, 'active_mode');
  const activeRate = attrInt(doc, 'active_rate');
  const activeBits = attrInt(doc, 'active_bits');
  let output: AudioFormat | null = null;
  if (activeRate) {
    const isDsd = activeBits === 1 || /sdm|dsd/i.test(activeMode ?? '');
    const kind = isDsd ? 'DSD' : 'PCM';
    output = {
      kind,
      sampleRate: activeRate,
      bits: activeBits,
      channels: attrInt(doc, 'active_channels'),
      label: formatLabel(kind, activeRate, isDsd ? null : activeBits),
    };
  }

  const trackIndex = toStudioIndex(attrInt(doc, 'track'));
  const uri = meta ? attrStr(meta, 'uri') : null; // secure_uri requires a session key → null
  const randomRaw = attrInt(doc, 'random');

  return {
    transport: mapTransport(attrInt(doc, 'state')),
    positionMs,
    durationMs,
    track:
      meta || trackIndex !== null
        ? {
            index: trackIndex,
            uri,
            title: text(meta, 'song'),
            artist: text(meta, 'artist'),
            album: text(meta, 'album'),
            durationMs,
            studioTrackId: null,
          }
        : null,
    trackIndex,
    // NOT tracks_total: it read 0 while the playlist held 52 items (probe 2026-11-10). The Live
    // adapter fills trackCount from PlaylistGet instead.
    trackCount: null,
    volumeDb: attrFloat(doc, 'volume'),
    volumeRange: null,
    input,
    output,
    dsp: {
      mode: activeMode,
      filter: attrStr(doc, 'active_filter'),
      shaper: attrStr(doc, 'active_shaper'),
      outputRate: activeRate,
    },
    repeat: mapRepeat(attrInt(doc, 'repeat')),
    random: randomRaw === null ? null : randomRaw === 1,
    albumMode: null,
    observedAt: now,
  };
}

export interface MappedState {
  transport: TransportState;
  volumeDb: number | null;
  repeat: RepeatMode | null;
  random: boolean | null;
  modeIndex: number | null;
  filterIndex: number | null;
  shaperIndex: number | null;
  rateIndex: number | null;
  matrixProfile: string | null;
}

export function mapStateDocument(doc: XmlElement): MappedState {
  const random = attrInt(doc, 'random');
  return {
    transport: mapTransport(attrInt(doc, 'state')),
    volumeDb: attrFloat(doc, 'volume'),
    repeat: mapRepeat(attrInt(doc, 'repeat')),
    random: random === null ? null : random === 1,
    modeIndex: attrInt(doc, 'mode'),
    filterIndex: attrInt(doc, 'filter'),
    shaperIndex: attrInt(doc, 'shaper'),
    rateIndex: attrInt(doc, 'rate'),
    matrixProfile: attrStr(doc, 'matrix_profile'),
  };
}
