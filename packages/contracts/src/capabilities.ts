import { z } from 'zod';

/**
 * Evidence level for an engine capability.
 *
 * - `confirmed`   verified against a real HQPlayer Desktop 6 install (recorded in docs/protocol-capabilities.md)
 * - `observed`    seen working on a real install, but not yet systematically verified
 * - `untested`    documented by the official SDK source, never exercised against Desktop 6
 * - `unsupported` known not to exist / not to work on the target engine
 * - `simulated`   provided by MockHQPlayerAdapter only — never implies real-engine support
 */
export const CapabilityStatusSchema = z.enum([
  'confirmed',
  'observed',
  'untested',
  'unsupported',
  'simulated',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const ENGINE_CAPABILITY_KEYS = [
  'connect',
  'status.read',
  'status.subscribe',
  'transport.play',
  'transport.pause',
  'transport.stop',
  'transport.next',
  'transport.previous',
  'transport.seek',
  'volume.read',
  'volume.set',
  'queue.replace',
  'queue.append',
  'queue.read',
  'queue.select',
  'mode.album',
  'playback.repeat',
  'playback.random',
  'playlist.server',
  'dsp.read',
  'dsp.write',
  'library.native',
] as const;
export const EngineCapabilityKeySchema = z.enum(ENGINE_CAPABILITY_KEYS);
export type EngineCapabilityKey = z.infer<typeof EngineCapabilityKeySchema>;

export const CapabilityEntrySchema = z.object({
  status: CapabilityStatusSchema,
  /** Whether Studio may expose this capability in the UI right now. */
  usable: z.boolean(),
  /** Short human-readable source of evidence, e.g. "SDK 6.0.1 ControlInterface::seek". */
  evidence: z.string().nullable(),
  note: z.string().nullable(),
});
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

export const EngineIdentitySchema = z.object({
  product: z.string(),
  version: z.string().nullable(),
  platform: z.string().nullable(),
  engine: z.string().nullable(),
});
export type EngineIdentity = z.infer<typeof EngineIdentitySchema>;

export const AdapterKindSchema = z.enum(['mock', 'live']);
export type AdapterKind = z.infer<typeof AdapterKindSchema>;

export const EngineCapabilitiesSchema = z.object({
  adapter: AdapterKindSchema,
  engine: EngineIdentitySchema.nullable(),
  items: z.record(EngineCapabilityKeySchema, CapabilityEntrySchema),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

/** Policy: which evidence levels may be enabled in the UI. */
export function isCapabilityStatusUsable(status: CapabilityStatus, allowUntested = false): boolean {
  switch (status) {
    case 'confirmed':
    case 'observed':
    case 'simulated':
      return true;
    case 'untested':
      return allowUntested;
    case 'unsupported':
      return false;
  }
}

export function canUse(
  capabilities: EngineCapabilities | null | undefined,
  key: EngineCapabilityKey,
): boolean {
  return capabilities?.items[key]?.usable ?? false;
}
