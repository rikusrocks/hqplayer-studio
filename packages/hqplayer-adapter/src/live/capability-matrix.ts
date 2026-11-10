import {
  ENGINE_CAPABILITY_KEYS,
  type CapabilityEntry,
  type CapabilityStatus,
  type EngineCapabilityKey,
} from '@hqps/contracts';

export interface CapabilityEvidence {
  status: CapabilityStatus;
  /** Read-only capabilities may be exercised while still `untested` (Gate A/B are side-effect free). */
  readOnly: boolean;
  evidence: string;
  note: string | null;
}

/**
 * Evidence for the user's HQPlayer Desktop 6 (engine 6.1.0, Windows).
 * - Read paths: exercised by hqp-probe v0.1.0 (stopped) and v0.1.1 (playing) on 2026-11-10
 *   (Gate A/B, 19/19 commands answered each time).
 * - Write paths: still SDK-only (`untested`) — they stay disabled until Gate C with consent.
 * Update this table (and docs/protocol-capabilities.md) from probe reports / Gate C records only.
 */
export const DESKTOP6_EVIDENCE: Record<EngineCapabilityKey, CapabilityEvidence> = {
  connect: {
    status: 'confirmed',
    readOnly: true,
    evidence: 'GetInfo over 127.0.0.1:4321 (probe 2026-11-10, engine 6.1.0), no auth required',
    note: null,
  },
  'status.read': {
    status: 'confirmed',
    readOnly: true,
    evidence: 'Status subscribe="0" + State (probe 2026-11-10, engine 6.1.0)',
    note: 'Stopped + playing observed: position/length in seconds, output_delay in µs (audible = position − delay); Status track base is verified at runtime by URI match.',
  },
  'status.subscribe': {
    status: 'confirmed',
    readOnly: true,
    evidence:
      'Status subscribe="1": ~1 push/s while playing (median 1001 ms), on change while stopped (probes 2026-11-10, engine 6.1.0)',
    note: null,
  },
  'transport.play': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK Play last="0|1"',
    note: null,
  },
  'transport.pause': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK Pause',
    note: 'Toggle vs. idempotent pause unknown.',
  },
  'transport.stop': { status: 'untested', readOnly: false, evidence: 'SDK Stop', note: null },
  'transport.next': { status: 'untested', readOnly: false, evidence: 'SDK Next', note: null },
  'transport.previous': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK Previous',
    note: null,
  },
  'transport.seek': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK Seek position=<int>',
    note: 'Unit assumed seconds.',
  },
  'volume.read': {
    status: 'confirmed',
    readOnly: true,
    evidence: 'Status volume + VolumeRange min=-12 max=0 (probe 2026-11-10, engine 6.1.0)',
    note: null,
  },
  'volume.set': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK Volume value=<double>',
    note: 'VolumeRange reported enabled="0" on this install — remote volume may be disabled in HQPlayer. Never changed automatically.',
  },
  'queue.replace': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK PlaylistClear + PlaylistAdd + SelectTrack',
    note: 'URI/path encoding for CJK paths unverified (Gate C).',
  },
  'queue.append': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK PlaylistAdd queued="1"',
    note: null,
  },
  'queue.read': {
    status: 'confirmed',
    readOnly: true,
    evidence: 'PlaylistGet returned the current playlist (probe 2026-11-10, engine 6.1.0)',
    note: 'PlaylistItem index is 1-based; uri is "file://" + raw Windows path (backslashes, unencoded spaces/non-ASCII).',
  },
  'queue.select': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK SelectTrack index=',
    note: 'Presumed 1-based like PlaylistItem.index and Status track (both observed); confirm in Gate C.',
  },
  'mode.album': {
    status: 'unsupported',
    readOnly: false,
    evidence: 'SDK PlaylistGet exposes read-only album="0|1"',
    note: 'No command to switch Album/Playlist mode exists in SDK 6.0.1.',
  },
  'playback.repeat': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK SetRepeat value=0|1|2',
    note: null,
  },
  'playback.random': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK SetRandom value=0|1',
    note: null,
  },
  'playlist.server': {
    status: 'untested',
    readOnly: false,
    evidence:
      'PlaylistGetList answered (no saved playlists) (probe 2026-11-10, engine 6.1.0); Load/Save/Delete SDK-only',
    note: 'Studio owns saved playlists; server playlists are optional.',
  },
  'dsp.read': {
    status: 'confirmed',
    readOnly: true,
    evidence:
      'GetModes 3 / GetFilters 77 / GetShapers 36 / GetRates 21 + Status active_* (probe 2026-11-10, engine 6.1.0)',
    note: 'State mode/filter/shaper/rate are list indexes, not values.',
  },
  'dsp.write': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK SetMode/SetFilter/SetShaping/SetRate',
    note: 'Disabled until verified and explicitly enabled by the user.',
  },
  'library.native': {
    status: 'observed',
    readOnly: true,
    evidence: 'LibraryGetHash answered (probe 2026-11-10, engine 6.1.0); LibraryGet not run',
    note: 'Optional; Studio keeps its own library.',
  },
};

export interface CapabilityPolicy {
  /** Gate C: the user explicitly allowed exercising untested *write* commands. */
  allowUntestedWrites?: boolean;
}

export function resolveCapabilities(
  evidence: Record<EngineCapabilityKey, CapabilityEvidence>,
  connected: boolean,
  policy: CapabilityPolicy = {},
): Record<EngineCapabilityKey, CapabilityEntry> {
  const out = {} as Record<EngineCapabilityKey, CapabilityEntry>;
  for (const key of ENGINE_CAPABILITY_KEYS) {
    const e = evidence[key];
    let usable: boolean;
    if (!connected || e.status === 'unsupported') usable = false;
    else if (key === 'dsp.write')
      usable = false; // never automatic in Phase 0/1
    else if (e.status === 'confirmed' || e.status === 'observed') usable = true;
    else if (e.status === 'untested') usable = e.readOnly || Boolean(policy.allowUntestedWrites);
    else usable = false;
    out[key] = { status: e.status, usable, evidence: e.evidence, note: e.note };
  }
  return out;
}
