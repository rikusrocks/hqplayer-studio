import { z } from 'zod';

// ------------------------------------------------------------------ database backups

export const BackupKindSchema = z.enum(['daily', 'pre-migration', 'manual', 'pre-restore']);
export type BackupKind = z.infer<typeof BackupKindSchema>;

export const BackupInfoSchema = z.object({
  /** File name (the API never takes or returns paths). */
  id: z.string(),
  kind: BackupKindSchema,
  createdAt: z.number(),
  /** Database schema version inside the backup (0 = unknown). */
  schemaVersion: z.number().int(),
  /** Studio version that made the backup. */
  appVersion: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** False when the backup is from a newer Studio (schema above what this version knows). */
  restorable: z.boolean(),
});
export type BackupInfo = z.infer<typeof BackupInfoSchema>;

export const RestoreResultSchema = z.object({
  ok: z.boolean(),
  backupId: z.string(),
  at: z.number(),
  /** The `pre-restore` backup that holds the data the restore replaced. */
  safetyBackupId: z.string().nullable(),
  error: z.string().nullable(),
});
export type RestoreResult = z.infer<typeof RestoreResultSchema>;

export const BackupStateSchema = z.object({
  /** False for an in-memory database (tests); everything else is then empty. */
  available: z.boolean(),
  schemaVersion: z.number().int(),
  supportedSchemaVersion: z.number().int(),
  backups: z.array(BackupInfoSchema),
  /** Backup that will replace the data at the next start (after "restore"). */
  pendingRestore: z.string().nullable(),
  lastRestore: RestoreResultSchema.nullable(),
  lastDailyAt: z.number().nullable(),
  /** A backup is being written right now. */
  running: z.boolean(),
  /** Last automatic backup error, if the latest attempt failed. */
  lastError: z.string().nullable(),
});
export type BackupState = z.infer<typeof BackupStateSchema>;

export const RestoreRequestSchema = z.object({ id: z.string().min(1).max(200) });
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>;

// ------------------------------------------------------------------ local logs

export const LogInfoSchema = z.object({
  /** False when Studio runs without a log folder (tests / tools). */
  enabled: z.boolean(),
  since: z.string(),
  counts: z.object({ info: z.number(), warn: z.number(), error: z.number() }),
  files: z.array(z.object({ name: z.string(), sizeBytes: z.number() })),
  problems: z.array(z.string()),
  crashReports: z.array(
    z.object({ name: z.string(), at: z.string(), kind: z.string(), summary: z.string() }),
  ),
  previousSessionUnclean: z
    .object({ startedAt: z.string(), lastAliveAt: z.string(), appVersion: z.string() })
    .nullable(),
});
export type LogInfo = z.infer<typeof LogInfoSchema>;

// ------------------------------------------------------------------ soak test (long listening test)

export const SoakIncidentKindSchema = z.enum([
  /** No status from HQPlayer for longer than the threshold while it was playing. */
  'status_gap',
  /** Playing, statuses arrive, but the position does not move. */
  'position_stall',
  /** Playback stopped / paused / started without a Studio command and not at the end of a track. */
  'transport_external',
  /** Track changed mid-track without a Studio command (HQPlayer's own UI, or a fault). */
  'track_external',
  /** Position jumped without a Studio seek. */
  'position_jump',
  /** The HQPlayer connection dropped. */
  'disconnect',
  'reconnect',
  /** A command Studio sent failed or timed out. */
  'command_failed',
  /** Studio's own main thread was blocked (could delay status handling / commands). */
  'studio_stall',
  /** Studio's queue no longer matches HQPlayer's playlist. */
  'queue_out_of_sync',
]);
export type SoakIncidentKind = z.infer<typeof SoakIncidentKindSchema>;

export const SoakIncidentSchema = z.object({
  at: z.number(),
  kind: SoakIncidentKindSchema,
  severity: z.enum(['info', 'warning', 'error']),
  /** Short English description (no titles or paths). */
  detail: z.string(),
  durationMs: z.number().nullable(),
  /** What Studio was doing around that moment. */
  context: z.object({
    transport: z.string(),
    output: z.string().nullable(),
    /** Studio write command running or finished within the attribution window. */
    studioCommand: z.string().nullable(),
    studioCommandAgoMs: z.number().nullable(),
    /** Library scans running (or ended moments ago), by trigger. */
    scans: z.array(z.string()),
    /** Studio's main thread was blocked shortly before. */
    studioStall: z.boolean(),
  }),
  /** Studio was active at that moment (command, scan, or a stall of its own). */
  studioActivity: z.boolean(),
});
export type SoakIncident = z.infer<typeof SoakIncidentSchema>;

export const SoakVerdictSchema = z.enum([
  /** No warning-level incident. */
  'clean',
  /** Warnings occurred, none while Studio was doing anything. */
  'issues-without-studio-activity',
  /** At least one warning coincided with Studio activity: please send the report. */
  'issues-with-studio-activity',
]);
export type SoakVerdict = z.infer<typeof SoakVerdictSchema>;

export const SoakStatusSchema = z.object({
  running: z.boolean(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  /** Auto-stop time, if a duration was chosen. */
  stopAt: z.number().nullable(),
  stopReason: z.enum(['user', 'time-limit', 'app-quit']).nullable(),
  /** File name of the report (in the soak report folder). */
  reportFile: z.string().nullable(),
  elapsedMs: z.number(),
  playingMs: z.number(),
  scanMs: z.number(),
  playingWhileScanningMs: z.number(),
  statusUpdates: z.number(),
  maxStatusIntervalMs: z.number(),
  incidentCounts: z.record(z.string(), z.number()),
  warnings: z.number(),
  warningsWithStudioActivity: z.number(),
  verdict: SoakVerdictSchema.nullable(),
  /** Latest incidents, newest first. */
  recent: z.array(SoakIncidentSchema),
});
export type SoakStatus = z.infer<typeof SoakStatusSchema>;

export const SoakStartRequestSchema = z.object({
  /** Stop by itself after this many hours (null = until stopped). */
  durationHours: z.number().positive().max(72).nullable().default(null),
});
export type SoakStartRequest = z.infer<typeof SoakStartRequestSchema>;
