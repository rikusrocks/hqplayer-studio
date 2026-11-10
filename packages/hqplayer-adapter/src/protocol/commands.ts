/**
 * HQPlayer Control API command registry.
 *
 * Source of truth: the official Signalyst SDK "hqp-control-601-src" (engine 6.0.1),
 * ControlInterface.cpp/.hpp (MIT licensed, © Jussi Laako — see THIRD_PARTY_NOTICES.md).
 * Every entry below exists in that SDK. Being listed here means "documented by the SDK",
 * NOT "verified on HQPlayer Desktop 6": runtime evidence lives in docs/protocol-capabilities.md
 * and in `capability-matrix.ts`.
 *
 * `sideEffect` drives safety policy:
 *  - `none`      read-only; allowed in the Gate B read-only probe
 *  - `session`   affects only this control connection (e.g. Status subscription)
 *  - `playback`  changes what/how audio is playing (Gate C, explicit user consent)
 *  - `queue`     edits HQPlayer's current playlist (Gate C)
 *  - `persist`   writes persistent server state: saved playlists, favourites, library (Gate C+)
 *  - `settings`  changes DSP/output/engine configuration (never automatic; explicit consent)
 *  - `sensitive` read-only but returns personal data (licence holder) — excluded from probe
 */
export type CommandSideEffect =
  'none' | 'session' | 'playback' | 'queue' | 'persist' | 'settings' | 'sensitive';

export type ResponseShape =
  | 'single' // one element with attributes, root name == command
  | 'list' // root element == command, with *Item children
  | 'ack' // <Cmd result="OK"/> or result="Error"
  | 'binary' // XML header followed by raw bytes (LibraryPicture) — unsupported by our framer
  | 'stream'; // response then unsolicited pushes (Status subscribe="1")

export interface CommandSpec {
  /** XML element name sent on the wire. */
  name: string;
  /** Method in SDK ControlInterface that emits it. */
  sdkMethod: string;
  /** Attribute names the SDK writes (order as in SDK). */
  attributes: readonly string[];
  sideEffect: CommandSideEffect;
  response: ResponseShape;
  /** Needs a SessionAuthentication session key (encrypted payloads). */
  requiresSession?: boolean;
  /** Included in the default read-only Gate B probe. */
  probe?: boolean;
  /** Response attributes that may contain personal data / local paths. */
  sensitiveAttributes?: readonly string[];
  note?: string;
}

const PATH_ATTRS = ['uri', 'path', 'cover', 'booklet', 'arg', 'value'] as const;
const MEDIA_TEXT_ATTRS = [
  'artist',
  'composer',
  'performer',
  'album',
  'albumartist',
  'album_artist',
  'song',
  'genre',
  'name',
] as const;

const specs: CommandSpec[] = [
  // --- session / identity
  {
    name: 'SessionAuthentication',
    sdkMethod: 'authenticate',
    attributes: ['client_id', 'public_key', 'signature'],
    sideEffect: 'session',
    response: 'single',
    note: 'ECDH(secp256r1)+signature handshake; requires a Signalyst-issued client key. Not used by Studio.',
  },
  {
    name: 'GetInfo',
    sdkMethod: 'getInfo',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
    sensitiveAttributes: ['name'],
  },
  {
    name: 'GetLicense',
    sdkMethod: 'getLicense',
    attributes: [],
    sideEffect: 'sensitive',
    response: 'single',
    sensitiveAttributes: ['name', 'fingerprint'],
    note: 'Returns licence holder name + fingerprint. Never probed.',
  },
  {
    name: 'Reset',
    sdkMethod: 'reset',
    attributes: [],
    sideEffect: 'settings',
    response: 'ack',
    note: 'Engine reset. Never sent by Studio.',
  },
  // --- configuration
  {
    name: 'ConfigurationList',
    sdkMethod: 'configurationList',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
    sensitiveAttributes: ['active', 'name'],
  },
  {
    name: 'ConfigurationGet',
    sdkMethod: 'configurationGet',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
    sensitiveAttributes: ['value'],
  },
  {
    name: 'ConfigurationLoad',
    sdkMethod: 'configurationLoad',
    attributes: ['value', 'nonce'],
    sideEffect: 'settings',
    response: 'ack',
    requiresSession: true,
  },
  // --- built-in library
  {
    name: 'LibraryLoad',
    sdkMethod: 'libraryLoad',
    attributes: ['value', 'nonce'],
    sideEffect: 'persist',
    response: 'ack',
    requiresSession: true,
    note: 'SDK comment: not implemented on v4/v5.',
  },
  {
    name: 'LibraryGetHash',
    sdkMethod: 'libraryGetHash',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
  },
  {
    name: 'LibraryGet',
    sdkMethod: 'libraryGet',
    attributes: ['pictures'],
    sideEffect: 'none',
    response: 'list',
    sensitiveAttributes: [...PATH_ATTRS, ...MEDIA_TEXT_ATTRS, 'hash'],
    note: 'Potentially very large; excluded from default probe.',
  },
  {
    name: 'LibraryPicture',
    sdkMethod: 'libraryPictureByPath/ByHash',
    attributes: ['path', 'hash'],
    sideEffect: 'none',
    response: 'binary',
  },
  {
    name: 'LibraryFavoriteGet',
    sdkMethod: 'libraryFavoriteGetByPath/ByHash',
    attributes: ['path', 'hash', 'file'],
    sideEffect: 'none',
    response: 'single',
  },
  {
    name: 'LibraryFavoriteSet',
    sdkMethod: 'libraryFavoriteSetByPath/ByHash',
    attributes: ['path', 'hash', 'file', 'value'],
    sideEffect: 'persist',
    response: 'single',
  },
  {
    name: 'LibraryFavoriteSetCurrent',
    sdkMethod: 'libraryFavoriteSetCurrent',
    attributes: ['value'],
    sideEffect: 'persist',
    response: 'single',
  },
  // --- current playlist (engine queue)
  {
    name: 'PlaylistAdd',
    sdkMethod: 'playlistAdd',
    attributes: ['uri', 'secure_uri', 'nonce', 'queued', 'clear', 'start', 'freewheel'],
    sideEffect: 'queue',
    response: 'ack',
    note: 'Optional <metadata .../> child. CLI passes file:/http(s):/audio: URIs or a native canonical path.',
  },
  {
    name: 'PlaylistRemove',
    sdkMethod: 'playlistRemove',
    attributes: ['index'],
    sideEffect: 'queue',
    response: 'ack',
  },
  {
    name: 'PlaylistMoveUp',
    sdkMethod: 'playlistMoveUp',
    attributes: ['index'],
    sideEffect: 'queue',
    response: 'ack',
  },
  {
    name: 'PlaylistMoveDown',
    sdkMethod: 'playlistMoveDown',
    attributes: ['index'],
    sideEffect: 'queue',
    response: 'ack',
  },
  {
    name: 'PlaylistGet',
    sdkMethod: 'playlistGet',
    attributes: ['picture'],
    sideEffect: 'none',
    response: 'list',
    probe: true,
    sensitiveAttributes: [...PATH_ATTRS, ...MEDIA_TEXT_ATTRS, 'picture'],
  },
  {
    name: 'PlaylistClear',
    sdkMethod: 'playlistClear',
    attributes: [],
    sideEffect: 'queue',
    response: 'ack',
  },
  // --- server-side saved playlists
  {
    name: 'PlaylistGetList',
    sdkMethod: 'playlistGetList',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
    sensitiveAttributes: ['name'],
  },
  {
    name: 'PlaylistGetSingle',
    sdkMethod: 'playlistGetSingle',
    attributes: ['name'],
    sideEffect: 'none',
    response: 'list',
    sensitiveAttributes: [...PATH_ATTRS, ...MEDIA_TEXT_ATTRS],
  },
  {
    name: 'PlaylistGetAll',
    sdkMethod: 'playlistGetAll',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    sensitiveAttributes: [...PATH_ATTRS, ...MEDIA_TEXT_ATTRS],
  },
  {
    name: 'PlaylistLoad',
    sdkMethod: 'playlistLoad',
    attributes: ['name'],
    sideEffect: 'queue',
    response: 'ack',
  },
  {
    name: 'PlaylistSave',
    sdkMethod: 'playlistSave',
    attributes: ['name'],
    sideEffect: 'persist',
    response: 'ack',
  },
  {
    name: 'PlaylistDelete',
    sdkMethod: 'playlistDelete',
    attributes: ['name'],
    sideEffect: 'persist',
    response: 'ack',
  },
  {
    name: 'PlaylistUpload',
    sdkMethod: 'playlistUpload',
    attributes: ['filename'],
    sideEffect: 'persist',
    response: 'ack',
  },
  // --- matrix
  {
    name: 'MatrixListProfiles',
    sdkMethod: 'matrixListProfiles',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
  },
  {
    name: 'MatrixGetProfile',
    sdkMethod: 'matrixGetProfile',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
  },
  {
    name: 'MatrixSetProfile',
    sdkMethod: 'matrixSetProfile',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  // --- transport
  {
    name: 'SelectTrack',
    sdkMethod: 'selectTrack',
    attributes: ['index'],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'LoadRemovable',
    sdkMethod: 'loadRemovable',
    attributes: [],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'Play',
    sdkMethod: 'play',
    attributes: ['last'],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'PlayNextURI',
    sdkMethod: 'playNextURI',
    attributes: ['value', 'secure_value', 'nonce', 'freewheel'],
    sideEffect: 'playback',
    response: 'ack',
  },
  { name: 'Pause', sdkMethod: 'pause', attributes: [], sideEffect: 'playback', response: 'ack' },
  { name: 'Stop', sdkMethod: 'stop', attributes: [], sideEffect: 'playback', response: 'ack' },
  {
    name: 'Previous',
    sdkMethod: 'previous',
    attributes: [],
    sideEffect: 'playback',
    response: 'ack',
  },
  { name: 'Next', sdkMethod: 'next', attributes: [], sideEffect: 'playback', response: 'ack' },
  {
    name: 'Backward',
    sdkMethod: 'backward',
    attributes: [],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'Forward',
    sdkMethod: 'forward',
    attributes: [],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'Seek',
    sdkMethod: 'seek',
    attributes: ['position'],
    sideEffect: 'playback',
    response: 'ack',
    note: 'SDK passes an int; unit assumed seconds (to verify).',
  },
  // --- volume
  {
    name: 'VolumeDown',
    sdkMethod: 'volumeDown',
    attributes: [],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'VolumeUp',
    sdkMethod: 'volumeUp',
    attributes: [],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'VolumeMute',
    sdkMethod: 'volumeMute',
    attributes: [],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'Volume',
    sdkMethod: 'volume',
    attributes: ['value'],
    sideEffect: 'playback',
    response: 'ack',
    note: 'double, assumed dB.',
  },
  {
    name: 'VolumeRange',
    sdkMethod: 'volumeRange',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
  },
  // --- state
  {
    name: 'State',
    sdkMethod: 'state',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
  },
  {
    name: 'Status',
    sdkMethod: 'status',
    attributes: ['subscribe'],
    sideEffect: 'none',
    response: 'stream',
    probe: true,
    sensitiveAttributes: [...PATH_ATTRS, ...MEDIA_TEXT_ATTRS, 'track_id'],
    note: 'subscribe="1" turns on unsolicited Status pushes for this connection (session-scoped).',
  },
  // --- DSP / output settings
  {
    name: 'SetMode',
    sdkMethod: 'setMode',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'GetModes',
    sdkMethod: 'getModes',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
  },
  {
    name: 'SetFilter',
    sdkMethod: 'setFilter',
    attributes: ['value', 'value1x'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'GetFilters',
    sdkMethod: 'getFilters',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
  },
  {
    name: 'SetShaping',
    sdkMethod: 'setShaping',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'GetShapers',
    sdkMethod: 'getShapers',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
  },
  {
    name: 'SetRate',
    sdkMethod: 'setRate',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'GetRates',
    sdkMethod: 'getRates',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
  },
  {
    name: 'SetJunkFilter',
    sdkMethod: 'setJunkFilter',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'GetJunkFilters',
    sdkMethod: 'getJunkFilters',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
  },
  {
    name: 'SetInvert',
    sdkMethod: 'setInvert',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'SetAdaptiveVolume',
    sdkMethod: 'setAdaptive',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'SetConvolution',
    sdkMethod: 'setConvolution',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'SetRepeat',
    sdkMethod: 'setRepeat',
    attributes: ['value'],
    sideEffect: 'playback',
    response: 'ack',
    note: '0 none, 1 single, 2 all (SDK enum Repeat).',
  },
  {
    name: 'SetRandom',
    sdkMethod: 'setRandom',
    attributes: ['value'],
    sideEffect: 'playback',
    response: 'ack',
  },
  {
    name: 'SetDisplay',
    sdkMethod: 'setDisplay',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'GetDisplay',
    sdkMethod: 'getDisplay',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
  },
  {
    name: 'GetTransport',
    sdkMethod: 'getTransport',
    attributes: [],
    sideEffect: 'none',
    response: 'single',
    probe: true,
    sensitiveAttributes: ['arg'],
  },
  {
    name: 'SetTransport',
    sdkMethod: 'setTransport',
    attributes: ['value', 'arg', 'freewheel'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'SetTransportPath',
    sdkMethod: 'setTransportPath',
    attributes: ['value', 'freewheel'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'SetTransportRate',
    sdkMethod: 'setTransportRate',
    attributes: ['value'],
    sideEffect: 'settings',
    response: 'ack',
  },
  {
    name: 'GetInputs',
    sdkMethod: 'getInputs',
    attributes: [],
    sideEffect: 'none',
    response: 'list',
    probe: true,
  },
];

export const HQP_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map(
  specs.map((s) => [s.name, s]),
);

export const SDK_SOURCE = {
  name: 'HQPlayer SDK (hqp-control-601-src)',
  engineVersion: '6.0.1',
  files: ['ControlInterface.hpp', 'ControlInterface.cpp', 'ControlApplication.cpp'],
  url: 'https://signalyst.com/downloads/',
  license: 'MIT, © 2011-2026 Jussi Laako',
} as const;

export const DEFAULT_CONTROL_PORT = 4321;
/** Metering stream uses control port + 1 (SDK clMeterInterface::setServer). */
export const METER_PORT_OFFSET = 1;
/** UDP multicast discovery (SDK discoverHosts). */
export const DISCOVERY_GROUPS = { ipv4: '239.192.0.199', ipv6: 'ff08::c7' } as const;

export function getCommand(name: string): CommandSpec {
  const spec = HQP_COMMANDS.get(name);
  if (!spec) throw new Error(`Unknown HQPlayer command "${name}" (not in SDK 6.0.1 registry)`);
  return spec;
}

export function isReadOnly(spec: CommandSpec): boolean {
  return spec.sideEffect === 'none';
}

/** Commands the read-only probe may send (Gate A/B). */
export function probeCommands(): CommandSpec[] {
  return specs.filter((s) => s.probe && s.sideEffect === 'none');
}
