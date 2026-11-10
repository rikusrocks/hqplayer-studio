import os from 'node:os';
import {
  DEFAULT_CONTROL_PORT,
  getCommand,
  HqpConnection,
  SDK_SOURCE,
  type TranscriptEntry,
  type XmlElement,
} from '@hqps/hqplayer-adapter';
import { sanitizeElement, type SanitizedElement } from './sanitize';

export const PROBE_VERSION = '0.1.0';
export const REPORT_SCHEMA = 'hqps.probe.v1';

/**
 * Gate B plan: only side-effect-free commands documented in SDK 6.0.1, in a deliberate order
 * (identity → state → DSP lists → configuration names → playlists). No command here can change
 * playback, the queue, settings or the licence. `HqpConnection` enforces this a second time.
 */
export const READ_ONLY_PLAN: { name: string; attributes?: Record<string, number> }[] = [
  { name: 'GetInfo' },
  { name: 'State' },
  { name: 'Status', attributes: { subscribe: 0 } },
  { name: 'VolumeRange' },
  { name: 'GetModes' },
  { name: 'GetFilters' },
  { name: 'GetShapers' },
  { name: 'GetRates' },
  { name: 'GetJunkFilters' },
  { name: 'GetDisplay' },
  { name: 'GetTransport' },
  { name: 'GetInputs' },
  { name: 'MatrixGetProfile' },
  { name: 'MatrixListProfiles' },
  { name: 'ConfigurationGet' },
  { name: 'ConfigurationList' },
  { name: 'LibraryGetHash' },
  { name: 'PlaylistGet', attributes: { picture: 0 } },
  { name: 'PlaylistGetList' },
];

export interface ProbeOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  /** How long to watch Status pushes after `Status subscribe="1"`. */
  subscribeWatchMs?: number;
  passiveListenMs?: number;
  /** Keep an unsanitised transcript in memory (written to a separate file by the CLI). */
  keepRawTranscript?: boolean;
  log?: (line: string) => void;
}

export interface CommandResult {
  command: string;
  sideEffect: string;
  sent: string;
  ok: boolean;
  ms: number;
  error?: string;
  response?: SanitizedElement;
}

export interface ProbeReport {
  schema: typeof REPORT_SCHEMA;
  probeVersion: string;
  generatedAt: string;
  mode: 'read-only (Gate A + Gate B)';
  sanitized: true;
  environment: { platform: string; release: string; arch: string; node: string };
  target: { host: string; port: number };
  sdkReference: typeof SDK_SOURCE;
  gateA: {
    tcpConnect: { ok: boolean; ms: number; error?: string };
    passiveListen: { ms: number; documents: number; firstRoot: string | null };
  };
  gateB: { commands: CommandResult[] };
  statusSubscription: {
    attempted: boolean;
    acknowledged: boolean;
    watchMs: number;
    pushes: number;
    medianIntervalMs: number | null;
    sample: SanitizedElement | null;
  };
  summary: {
    reachable: boolean;
    engine: Record<string, string | null> | null;
    commandsOk: number;
    commandsFailed: number;
    framing: string;
    notes: string[];
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}

export async function runProbe(
  options: ProbeOptions = {},
): Promise<{ report: ProbeReport; rawTranscript: TranscriptEntry[] }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_CONTROL_PORT;
  const timeoutMs = options.timeoutMs ?? 3000;
  const log = options.log ?? (() => undefined);
  const raw: TranscriptEntry[] = [];
  const notes: string[] = [];
  const unsolicited: { at: number; doc: XmlElement }[] = [];

  const report: ProbeReport = {
    schema: REPORT_SCHEMA,
    probeVersion: PROBE_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'read-only (Gate A + Gate B)',
    sanitized: true,
    // Deliberately no hostname, user name, IP addresses or paths.
    environment: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      node: process.versions.node,
    },
    target: { host, port },
    sdkReference: SDK_SOURCE,
    gateA: {
      tcpConnect: { ok: false, ms: 0 },
      passiveListen: { ms: 0, documents: 0, firstRoot: null },
    },
    gateB: { commands: [] },
    statusSubscription: {
      attempted: false,
      acknowledged: false,
      watchMs: 0,
      pushes: 0,
      medianIntervalMs: null,
      sample: null,
    },
    summary: {
      reachable: false,
      engine: null,
      commandsOk: 0,
      commandsFailed: 0,
      framing: 'unknown',
      notes,
    },
  };

  const conn = new HqpConnection({
    host,
    port,
    connectTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs,
    allowSideEffects: false,
    onTranscript: options.keepRawTranscript ? (e) => raw.push(e) : undefined,
  });
  conn.onUnsolicited((doc) => unsolicited.push({ at: Date.now(), doc }));

  // --- Gate A: TCP connect + passive listen ------------------------------------------------------
  const t0 = performance.now();
  try {
    await conn.connect();
    report.gateA.tcpConnect = { ok: true, ms: Math.round(performance.now() - t0) };
    log(`TCP ${host}:${port} OK (${report.gateA.tcpConnect.ms} ms)`);
  } catch (err) {
    report.gateA.tcpConnect = {
      ok: false,
      ms: Math.round(performance.now() - t0),
      error: (err as Error).message,
    };
    notes.push(
      'TCP connection failed: is HQPlayer Desktop running on this PC, and is "Allow control from network" / the control API enabled?',
    );
    log(`TCP ${host}:${port} FAILED: ${(err as Error).message}`);
    return { report, rawTranscript: raw };
  }
  report.summary.reachable = true;

  const passiveMs = options.passiveListenMs ?? 750;
  await new Promise((r) => setTimeout(r, passiveMs));
  report.gateA.passiveListen = {
    ms: passiveMs,
    documents: unsolicited.length,
    firstRoot: unsolicited[0]?.doc.name ?? null,
  };
  unsolicited.length = 0;

  // --- Gate B: read-only commands -----------------------------------------------------------------
  let sawNewlineFraming = false;
  for (const step of READ_ONLY_PLAN) {
    if (!conn.connected) {
      notes.push(`Connection closed before ${step.name}; remaining commands skipped.`);
      break;
    }
    const spec = getCommand(step.name);
    const sent = `<${step.name}${Object.entries(step.attributes ?? {})
      .map(([k, v]) => ` ${k}="${v}"`)
      .join('')}/>`;
    const started = performance.now();
    try {
      const doc = await conn.request(step.name, step.attributes ?? {});
      const ms = Math.round(performance.now() - started);
      sawNewlineFraming = true;
      report.gateB.commands.push({
        command: step.name,
        sideEffect: spec.sideEffect,
        sent,
        ok: true,
        ms,
        response: sanitizeElement(doc, spec.sensitiveAttributes ?? []),
      });
      if (step.name === 'GetInfo') {
        report.summary.engine = {
          product: doc.attributes.product ?? null,
          version: doc.attributes.version ?? null,
          platform: doc.attributes.platform ?? null,
          engine: doc.attributes.engine ?? null,
        };
      }
      log(`  ✔ ${step.name} (${ms} ms)`);
    } catch (err) {
      report.gateB.commands.push({
        command: step.name,
        sideEffect: spec.sideEffect,
        sent,
        ok: false,
        ms: Math.round(performance.now() - started),
        error: `${(err as Error).name}: ${(err as Error).message}`,
      });
      log(`  ✘ ${step.name}: ${(err as Error).message}`);
    }
  }
  report.summary.commandsOk = report.gateB.commands.filter((c) => c.ok).length;
  report.summary.commandsFailed = report.gateB.commands.length - report.summary.commandsOk;
  report.summary.framing = sawNewlineFraming
    ? 'newline-terminated XML documents (matches SDK 6.0.1 client expectations)'
    : 'no complete response documents observed';
  if (unsolicited.length)
    notes.push(`${unsolicited.length} unsolicited/late document(s) arrived during Gate B.`);

  // --- Status subscription (connection-scoped, no engine side effects) ----------------------------
  if (conn.connected) {
    const watchMs = options.subscribeWatchMs ?? 3000;
    report.statusSubscription.attempted = true;
    report.statusSubscription.watchMs = watchMs;
    unsolicited.length = 0;
    try {
      const ack = await conn.request('Status', { subscribe: 1 });
      report.statusSubscription.acknowledged = true;
      report.statusSubscription.sample = sanitizeElement(
        ack,
        getCommand('Status').sensitiveAttributes ?? [],
      );
    } catch (err) {
      notes.push(`Status subscribe="1" not acknowledged: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, watchMs));
    const pushes = unsolicited.filter((u) => u.doc.name === 'Status');
    report.statusSubscription.pushes = pushes.length;
    report.statusSubscription.medianIntervalMs = median(
      pushes.slice(1).map((p, i) => p.at - (pushes[i]?.at ?? p.at)),
    );
    if (pushes.length === 0)
      notes.push(
        'No Status pushes observed while subscribed (engine idle, or pushes only on change).',
      );
  }

  conn.close();
  return { report, rawTranscript: raw };
}
