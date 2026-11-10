import { z } from 'zod';

/**
 * Web Remote on the home LAN (Phase 3).
 *
 * LAN listening is off by default. When the user enables it on this computer, Studio Core binds a
 * second listener on one private IPv4 address. Phones/tablets pair once with a short one-time code
 * and receive a long-lived per-device token (stored hashed on the PC).
 *
 *  - HTTP:      `Authorization: Bearer <token>`
 *  - WebSocket: subprotocols `hqps.v1` + `hqps.auth.<token>` (the server only ever selects
 *               `hqps.v1`; the token is never echoed back)
 *  - artwork:   `<img>` cannot send headers, so pairing also sets an HttpOnly cookie that is scoped
 *               to the artwork path and only unlocks artwork.
 *
 * Tokens are never accepted in query strings.
 */

/** WebSocket subprotocol every Studio client offers; the server selects it. */
export const WS_PROTOCOL = 'hqps.v1' as const;
/** Prefix of the WebSocket subprotocol that carries a device token. */
export const WS_AUTH_PROTOCOL_PREFIX = 'hqps.auth.' as const;
/** Close code sent to a WebSocket whose device was revoked (or LAN access was turned off). */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** Pairing codes are 6 digits; users may type them with spaces ("482 913"). */
export const PAIRING_CODE_LENGTH = 6;

export const RemoteAddressKindSchema = z.enum([
  'private',
  'public',
  'loopback',
  'link_local',
  'cgnat',
  'unspecified',
  'other',
]);
export type RemoteAddressKind = z.infer<typeof RemoteAddressKindSchema>;

/** A network interface of this computer, as offered for LAN listening. */
export const RemoteInterfaceSchema = z.object({
  name: z.string(),
  address: z.string(),
  kind: RemoteAddressKindSchema,
  /** Only private (RFC 1918) IPv4 addresses can be chosen. */
  usable: z.boolean(),
});
export type RemoteInterface = z.infer<typeof RemoteInterfaceSchema>;

export const RemoteListenerErrorSchema = z.enum([
  /** The chosen address is no longer on this computer (network changed). */
  'address_unavailable',
  /** The chosen address is not a private LAN address; Studio refuses to listen on it. */
  'address_not_private',
  /** Another program already uses the port on that address. */
  'port_in_use',
  'listen_failed',
]);
export type RemoteListenerError = z.infer<typeof RemoteListenerErrorSchema>;

export const RemoteDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  /** LAN address the device last connected from (shown on this computer only). */
  lastAddress: z.string().nullable(),
  /** Has an open realtime connection right now. */
  connected: z.boolean(),
});
export type RemoteDevice = z.infer<typeof RemoteDeviceSchema>;

export const PairingCodeSchema = z.object({
  code: z.string(),
  expiresAt: z.number(),
  /** Remote URLs with `#pair=<code>` (fragment: never sent to the server) for the QR code. */
  urls: z.array(z.string()),
});
export type PairingCode = z.infer<typeof PairingCodeSchema>;

/** Settings → 网页遥控. Loopback clients only. */
export const RemoteSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Chosen interface (Windows names such as "Ethernet" / "Wi-Fi"). */
  interfaceName: z.string().nullable(),
  /** Chosen address; when the network changes Studio follows the same interface's new address. */
  address: z.string().nullable(),
  port: z.number().int(),
  state: z.enum(['off', 'listening', 'error']),
  error: RemoteListenerErrorSchema.nullable(),
  /** Remote URLs to open on a phone (only while listening). */
  urls: z.array(z.string()),
  interfaces: z.array(RemoteInterfaceSchema),
  pairing: PairingCodeSchema.nullable(),
  devices: z.array(RemoteDeviceSchema),
});
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;

export const UpdateRemoteSettingsRequestSchema = z.object({
  enabled: z.boolean(),
  interfaceName: z.string().min(1).max(200).optional(),
  address: z.string().min(1).max(64).optional(),
});
export type UpdateRemoteSettingsRequest = z.infer<typeof UpdateRemoteSettingsRequestSchema>;

/** Normalise what a user typed ("482 913", "482-913") to the bare digits. */
export function normalizePairingCode(input: string): string {
  return input.replace(/[\s-]/g, '');
}

export const PairRequestSchema = z.object({
  code: z
    .string()
    .max(32)
    .transform(normalizePairingCode)
    .pipe(z.string().regex(new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`), 'Invalid pairing code')),
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(60)
    // no control characters in names shown on the desktop
    .transform((s) => s.replace(/\p{Cc}/gu, '')),
});
export type PairRequest = z.input<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  token: z.string(),
  device: z.object({ id: z.string(), name: z.string() }),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const PairingStatusSchema = z.object({
  /** LAN listening is on. */
  lanEnabled: z.boolean(),
  /** Client on this computer: no pairing needed. */
  trusted: z.boolean(),
  /** The request carried a valid device token. */
  paired: z.boolean(),
  device: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type PairingStatus = z.infer<typeof PairingStatusSchema>;
