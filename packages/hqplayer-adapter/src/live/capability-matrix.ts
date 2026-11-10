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
 * Evidence for HQPlayer Desktop 6 as of 2026-11-10: everything is derived from the official SDK
 * 6.0.1 source; nothing has been exercised against a real Desktop 6 yet, so nothing is
 * `confirmed`. Update this table (and docs/protocol-capabilities.md) from probe reports only.
 */
export const DESKTOP6_EVIDENCE: Record<EngineCapabilityKey, CapabilityEvidence> = {
  connect: {
    status: 'untested',
    readOnly: true,
    evidence: 'SDK 6.0.1 connectToHost (TCP 4321)',
    note: 'TCP reachability on 127.0.0.1:4321 was seen with Test-NetConnection only.',
  },
  'status.read': {
    status: 'untested',
    readOnly: true,
    evidence: 'SDK Status subscribe="0" / State',
    note: null,
  },
  'status.subscribe': {
    status: 'untested',
    readOnly: true,
    evidence: 'SDK Status subscribe="1"',
    note: 'Push cadence unknown.',
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
    status: 'untested',
    readOnly: true,
    evidence: 'SDK Status volume / VolumeRange',
    note: null,
  },
  'volume.set': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK Volume value=<double>',
    note: 'Never changed automatically.',
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
    status: 'untested',
    readOnly: true,
    evidence: 'SDK PlaylistGet picture="0"',
    note: null,
  },
  'queue.select': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK SelectTrack index=',
    note: 'Index base (0/1) unverified.',
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
    evidence: 'SDK PlaylistGetList/Load/Save/Delete',
    note: 'Studio owns saved playlists; server playlists are optional.',
  },
  'dsp.read': {
    status: 'untested',
    readOnly: true,
    evidence: 'SDK GetModes/GetFilters/GetShapers/GetRates + State',
    note: null,
  },
  'dsp.write': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK SetMode/SetFilter/SetShaping/SetRate',
    note: 'Disabled until verified and explicitly enabled by the user.',
  },
  'library.native': {
    status: 'untested',
    readOnly: true,
    evidence: 'SDK LibraryGet / LibraryGetHash',
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
