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
 * - Read paths: hqp-probe v0.1.0 (stopped) and v0.1.1 (playing), 2026-11-10.
 * - Write paths: Gate C (hqp-gatec v0.1.0, approved plan, user present), 2026-11-10.
 * Confirmed writes are still only usable when the user enables "允许 Studio 控制 HQPlayer".
 * Update this table (and docs/protocol-capabilities.md) from probe / Gate C reports only.
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
    note: 'Position/length in seconds; output_delay in µs (audible = position − delay). Status track is 1-based once playback is steady (briefly 0 while starting).',
  },
  'status.subscribe': {
    status: 'confirmed',
    readOnly: true,
    evidence:
      'Status subscribe="1": ~1 push/s while playing, on change while stopped (probes 2026-11-10)',
    note: null,
  },
  'transport.play': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'Play last="0" from stopped (Gate C 2026-11-10, engine 6.1.0)',
    note: 'Audio/position start ~3 s after the ACK (buffering). From pause, Studio resumes with Pause (toggle).',
  },
  'transport.pause': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'Pause toggles: 2nd Pause resumed at the same spot (Gate C 2026-11-10, engine 6.1.0)',
    note: 'Studio only sends Pause while playing, so “pause” never accidentally resumes.',
  },
  'transport.stop': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'Stop (Gate C 2026-11-10, engine 6.1.0)',
    note: 'ACK takes ~3.8 s while playing; timeouts are sized accordingly.',
  },
  'transport.next': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'Next advanced 1 → 2 (Gate C 2026-11-10, engine 6.1.0)',
    note: 'ACK ~1.5 s.',
  },
  'transport.previous': {
    status: 'observed',
    readOnly: false,
    evidence:
      'HQPlayer Previous had no visible effect mid-track right after a seek (Gate C 2026-11-10, engine 6.1.0)',
    note: 'Studio implements “previous” with confirmed commands: Seek 0 if > 3 s in, otherwise SelectTrack(n−1) + Play.',
  },
  'transport.seek': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'Seek position=60 → engine at exactly 60.000 s (Gate C 2026-11-10, engine 6.1.0)',
    note: 'Unit: whole seconds. Audible position follows after the output delay.',
  },
  'volume.read': {
    status: 'confirmed',
    readOnly: true,
    evidence: 'Status volume + VolumeRange min=-12 max=0 (probe 2026-11-10)',
    note: null,
  },
  'volume.set': {
    status: 'unsupported',
    readOnly: false,
    evidence:
      'Volume (same value) rejected with result="Error" (Gate C 2026-11-10, engine 6.1.0); VolumeRange enabled="0"',
    note: 'Remote volume is disabled in this HQPlayer’s settings. Adjust volume in HQPlayer or on the amplifier.',
  },
  'queue.replace': {
    status: 'confirmed',
    readOnly: false,
    evidence:
      'PlaylistClear + PlaylistAdd (native paths incl. CJK/spaces) + SelectTrack + Play; PlaylistRemove 1-based (Gate C 2026-11-10, engine 6.1.0)',
    note: 'Replaces HQPlayer’s current playlist. Native paths are stored as "file://" + path.',
  },
  'queue.append': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'PlaylistAdd queued="1" clear="0" appends (Gate C 2026-11-10, engine 6.1.0)',
    note: '“Play Next” has no SDK command and stays unavailable on the real engine.',
  },
  'queue.read': {
    status: 'confirmed',
    readOnly: true,
    evidence: 'PlaylistGet returned the current playlist (probe 2026-11-10, engine 6.1.0)',
    note: 'PlaylistItem index is 1-based; uri is "file://" + raw Windows path (backslashes, unencoded spaces/non-ASCII).',
  },
  'queue.select': {
    status: 'confirmed',
    readOnly: false,
    evidence:
      'SelectTrack index="2" + Play played the 2nd item (1-based) (Gate C 2026-11-10, engine 6.1.0)',
    note: null,
  },
  'mode.album': {
    status: 'unsupported',
    readOnly: false,
    evidence: 'SDK PlaylistGet exposes read-only album="0|1"',
    note: 'No command to switch modes. Consecutive tracks were gapless in Playlist mode (Gate C, listener).',
  },
  'playback.repeat': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'SetRepeat 2 then 0, read back via State (Gate C 2026-11-10, engine 6.1.0)',
    note: null,
  },
  'playback.random': {
    status: 'confirmed',
    readOnly: false,
    evidence: 'SetRandom 1 then 0, read back via State (Gate C 2026-11-10, engine 6.1.0)',
    note: null,
  },
  'playlist.server': {
    status: 'untested',
    readOnly: false,
    evidence:
      'PlaylistGetList answered (no saved playlists) (probe 2026-11-10); Load/Save/Delete not tested',
    note: 'Studio owns saved playlists; server playlists are optional.',
  },
  'dsp.read': {
    status: 'confirmed',
    readOnly: true,
    evidence:
      'GetModes 3 / GetFilters 77 / GetShapers 36 / GetRates 21 + Status active_* (probe 2026-11-10)',
    note: 'State mode/filter/shaper/rate are list indexes, not values.',
  },
  'dsp.write': {
    status: 'untested',
    readOnly: false,
    evidence: 'SDK SetMode/SetFilter/SetShaping/SetRate',
    note: 'Never part of Gate C; stays disabled.',
  },
  'library.native': {
    status: 'observed',
    readOnly: true,
    evidence: 'LibraryGetHash answered (probe 2026-11-10); LibraryGet not run',
    note: 'Optional; Studio keeps its own library.',
  },
};

export interface CapabilityPolicy {
  /**
   * The user's switch “允许 Studio 控制 HQPlayer” (default off): enables write capabilities that
   * are confirmed/observed on this engine. Off = read-only, whatever the evidence.
   */
  controlEnabled?: boolean;
  /** Gate C test tooling only: also allow untested writes. */
  allowUntestedWrites?: boolean;
}

/** Facts read from the engine at runtime that can further restrict capabilities. */
export interface RuntimeLimits {
  /** VolumeRange enabled="0|1". */
  volumeControlEnabled?: boolean | null;
}

export const CONTROL_DISABLED_NOTE = 'control-disabled';

export function resolveCapabilities(
  evidence: Record<EngineCapabilityKey, CapabilityEvidence>,
  connected: boolean,
  policy: CapabilityPolicy = {},
  runtime: RuntimeLimits = {},
): Record<EngineCapabilityKey, CapabilityEntry> {
  const out = {} as Record<EngineCapabilityKey, CapabilityEntry>;
  for (const key of ENGINE_CAPABILITY_KEYS) {
    const e = evidence[key];
    let usable: boolean;
    let note = e.note;
    if (!connected || e.status === 'unsupported') usable = false;
    else if (key === 'dsp.write')
      usable = false; // never automatic
    else if (e.readOnly)
      usable = true; // side-effect free reads
    else if (e.status === 'confirmed' || e.status === 'observed') {
      usable = Boolean(policy.controlEnabled || policy.allowUntestedWrites);
      if (!usable) note = CONTROL_DISABLED_NOTE;
    } else if (e.status === 'untested') usable = Boolean(policy.allowUntestedWrites);
    else usable = false;
    if (key === 'volume.set' && runtime.volumeControlEnabled === false) usable = false;
    out[key] = { status: e.status, usable, evidence: e.evidence, note };
  }
  return out;
}
