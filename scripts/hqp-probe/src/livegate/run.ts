import os from 'node:os';
import { engineUriToPath, sameEnginePath } from '@hqps/contracts';
import {
  EngineCommandError,
  EngineUnavailableError,
  type XmlElement,
} from '@hqps/hqplayer-adapter';
import { describeValue, type SanitizedElement } from '../sanitize';
import { writeBackup, type BackupFile } from '../gatec/files';
import type { GateIO, StepRecord } from '../gatec/run';
import { GateGuardError, type LiveStatus, type PlaylistEntry } from '../gatec/session';
import { isAppleMusicApp, type MediaProbe, type MediaSessionInfo } from './media-sessions';
import { findLiveUris, isLiveUri, LiveGateSession, sanitizeLive } from './session';

export const LIVEGATE_VERSION = '0.1.0';
export const LIVEGATE_SCHEMA = 'hqps.livegate.v1';

/**
 * Tried in this order after anything HQPlayer itself lists. "default" = the input device chosen
 * in HQPlayer Settings → Input; rate 0 is reported to mean "detect the rate"; 2 = channels.
 * (Forum knowledge for HQPlayer 4/5 — whether engine 6.1.0 agrees is what this gate finds out.)
 */
export const DEFAULT_LIVE_URIS = [
  'audio:default/0/2',
  'audio:default/44100/2',
  'audio:default/48000/2',
] as const;

const MAX_CANDIDATES = 6;

export interface LiveAttempt {
  uri: string;
  cleared: boolean;
  addAccepted: boolean;
  /** How HQPlayer stored the entry: the `audio:` URI itself, or a description of anything else. */
  storedUri: string | null;
  storedLengthMs: number | null;
  playlistLength: number | null;
  playAccepted: boolean | null;
  reachedPlaying: boolean | null;
  msToPlaying: number | null;
  error: string | null;
}

export interface LiveGateReport {
  schema: typeof LIVEGATE_SCHEMA;
  toolVersion: string;
  generatedAt: string;
  plan: string;
  sanitized: true;
  environment: { platform: string; release: string; arch: string };
  engine: Record<string, string | null> | null;
  reachable: boolean;
  aborted: boolean;
  start: Record<string, unknown> | null;
  /** Read-only: what HQPlayer says about its inputs before anything is changed. */
  inputs: {
    getInputs: SanitizedElement | { error: string } | null;
    getTransport: SanitizedElement | { error: string } | null;
    listedLiveUris: string[];
    candidates: string[];
  };
  steps: StepRecord[];
  restore: {
    needed: boolean;
    performed: boolean;
    verified: boolean | null;
    expected: number;
    actual: number | null;
    mismatchedPositions: number[];
    reselected: boolean | null;
    notes: string[];
  };
  findings: Record<string, unknown>;
}

export interface LiveGateOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  timeScale?: number;
  outDir: string;
  io: GateIO;
  stamp: string;
  /** Extra live-input URIs to try first (from --uri). Must start with "audio:". */
  uris?: string[];
  media: MediaProbe;
}

/** Media session for the report: which fields exist and how big, never what they say. */
function describeSession(m: MediaSessionInfo) {
  return {
    app: m.app,
    appleMusic: isAppleMusicApp(m.app),
    current: m.current,
    status: m.status,
    hasTitle: m.title.length > 0,
    hasArtist: m.artist.length > 0,
    hasAlbum: m.album.length > 0,
    thumbnailBytes: m.thumbnailBytes,
    hasTimeline: m.endSec !== null && m.endSec > 0,
    controls: m.controls,
  };
}

async function readOnly(
  s: LiveGateSession,
  name: string,
  extraSensitive: readonly string[] = [],
): Promise<{ doc: XmlElement | null; report: SanitizedElement | { error: string } }> {
  try {
    const doc = await s.send(name);
    return { doc, report: sanitizeLive(doc, extraSensitive) };
  } catch (err) {
    if (!(err instanceof EngineCommandError)) throw err;
    return { doc: null, report: { error: s.redactor.apply((err as Error).message).slice(0, 300) } };
  }
}

export async function runLiveGate(o: LiveGateOptions): Promise<{
  report: LiveGateReport;
  backup: { json: string; m3u8: string } | null;
  exitCode: number;
}> {
  const { io, media } = o;
  const s = new LiveGateSession({
    host: o.host ?? '127.0.0.1',
    port: o.port ?? 4321,
    timeoutMs: o.timeoutMs,
    timeScale: o.timeScale,
  });
  const report: LiveGateReport = {
    schema: LIVEGATE_SCHEMA,
    toolVersion: LIVEGATE_VERSION,
    generatedAt: new Date().toISOString(),
    plan: 'live-input gate: play one audio: (live input) entry through HQPlayer, check Windows media sessions for Apple Music, restore the playlist',
    sanitized: true,
    environment: { platform: process.platform, release: os.release(), arch: process.arch },
    engine: null,
    reachable: false,
    aborted: false,
    start: null,
    inputs: { getInputs: null, getTransport: null, listedLiveUris: [], candidates: [] },
    steps: [],
    restore: {
      needed: false,
      performed: false,
      verified: null,
      expected: 0,
      actual: null,
      mismatchedPositions: [],
      reselected: null,
      notes: [],
    },
    findings: {},
  };

  try {
    await s.open();
  } catch (err) {
    io.print(`✘ 无法连接 HQPlayer / cannot connect: ${(err as Error).message}`);
    io.print('  请先打开 HQPlayer Desktop。/ Start HQPlayer Desktop first.');
    return { report, backup: null, exitCode: 3 };
  }
  report.reachable = true;

  // ---------------------------------------------------------------- L0: read-only + backup
  const info = await s.send('GetInfo');
  report.engine = {
    product: info.attributes.product ?? null,
    version: info.attributes.version ?? null,
    engine: info.attributes.engine ?? null,
    platform: info.attributes.platform ?? null,
  };
  const st0 = await s.state();
  const pl0 = await s.playlist();
  const status0 = s.status();
  let currentEngineIndex: number | null = null;
  if (status0?.uri)
    currentEngineIndex = pl0.entries.find((e) => e.uri === status0.uri)?.engineIndex ?? null;
  if (
    currentEngineIndex === null &&
    status0?.track &&
    status0.track >= 1 &&
    status0.track <= pl0.entries.length
  ) {
    currentEngineIndex = status0.track;
  }
  const backup: BackupFile = {
    createdAt: new Date().toISOString(),
    engine: report.engine,
    albumMode: pl0.albumMode,
    transport: st0.transport,
    statusTrack: status0?.track ?? null,
    currentEngineIndex,
    repeat: st0.raw.repeat ?? null,
    random: st0.raw.random ?? null,
    volume: st0.raw.volume ?? null,
    entries: pl0.entries,
  };
  const backupPaths = writeBackup(o.outDir, backup, o.stamp, 'hqp-livegate');
  // What goes back into the playlist at the end: the native path for files (the form Gate C
  // confirmed), the URI as it is for anything else.
  const restoreUris = pl0.entries.map((e) => (e.uri ? (engineUriToPath(e.uri) ?? e.uri) : null));
  for (const [i, e] of pl0.entries.entries()) {
    s.redactor.add(e.uri, restoreUris[i]);
    s.permit(restoreUris[i]);
  }
  report.restore.expected = pl0.entries.length;

  const inputs = await readOnly(s, 'GetInputs');
  const transport = await readOnly(s, 'GetTransport', ['arg']);
  const listed = inputs.doc ? findLiveUris(inputs.doc) : [];
  const candidates = [
    ...new Set([...(o.uris ?? []).filter(isLiveUri), ...listed, ...DEFAULT_LIVE_URIS]),
  ].slice(0, MAX_CANDIDATES);
  s.permit(...candidates);
  report.inputs = {
    getInputs: inputs.report,
    getTransport: transport.report,
    listedLiveUris: listed,
    candidates,
  };
  report.start = {
    transport: st0.transport,
    playlistLength: pl0.entries.length,
    albumMode: pl0.albumMode,
    currentEngineIndex,
    outputDelayMs: status0?.outputDelayMs ?? null,
    status: s.statusRaw(),
  };

  io.print(
    `\n✔ 已连接 ${report.engine.product ?? 'HQPlayer'} (engine ${report.engine.engine ?? '?'})`,
  );
  io.print(`✔ 已备份当前播放列表（${pl0.entries.length} 首）/ playlist backed up:`);
  io.print(`    ${backupPaths.m3u8}`);
  io.print(`    ${backupPaths.json}`);
  io.print(
    '  这两个备份文件含真实路径，只留在本机，不要发回。/ Keep these local; do not send them.',
  );
  io.print(
    `\nHQPlayer 列出的输入 / inputs HQPlayer lists: ${listed.length ? listed.join(', ') : '（无 / none）'}`,
  );
  io.print(`将依次尝试 / will try in this order: ${candidates.join(', ')}`);
  io.print('\n开始前请确认 / Before you start:');
  io.print(
    '  1. 已安装虚拟声卡，Apple Music 的声音输出到它，并且正在播放。/ A virtual audio cable is installed, Apple Music plays into it, and a song is playing.',
  );
  io.print(
    '  2. HQPlayer 设置 → Input 里选了这个虚拟声卡。/ HQPlayer Settings → Input is set to that cable.',
  );
  io.print(
    '  3. 放大器音量先调低：实时输入可能有突发噪声。/ Amplifier turned DOWN first: a live input can produce a burst of noise.',
  );

  const startAnswer = await io.ask('开始实时输入测试？/ Start the live-input test now?', {
    y: '开始 / start',
    n: '退出 / exit',
  });
  if (startAnswer !== 'y') {
    report.aborted = true;
    io.print('已退出，没有发送任何写命令。/ Exited without sending any write command.');
    s.close();
    return { report, backup: backupPaths, exitCode: 0 };
  }

  let aborted = false;
  let playlistModified = false;
  let playbackTouched = false;
  let stopped = st0.transport === 'stopped';
  let chosen: string | null = null;
  let appleApp: string | null = null;

  const snap = (st: LiveStatus | null) =>
    st && {
      transport: st.transport,
      track: st.track,
      uri: st.uri === null ? null : isLiveUri(st.uri) ? st.uri : describeValue(st.uri),
      enginePositionMs: st.enginePositionMs,
      outputDelayMs: st.outputDelayMs,
      durationMs: st.durationMs,
      tracksTotal: st.tracksTotal,
      input: st.inputLabel,
      output: st.outputLabel,
    };
  const check = (rec: StepRecord, ok: boolean, note: string) => {
    if (!ok) {
      rec.result = 'fail';
      rec.notes.push(note);
    }
  };
  const ask = async (
    rec: StepRecord,
    key: string,
    question: string,
    choices: Record<string, string>,
  ) => {
    const a = await io.ask(question, choices);
    rec.answers[key] = a;
    return a;
  };
  /** Watch the pushed Status for a while and summarise what the engine did. */
  const watch = async (ms: number) => {
    const log: LiveStatus[] = [];
    const before = s.status();
    s.watchStatus(log);
    await s.sleep(ms);
    s.watchStatus(null);
    const after = s.status();
    return {
      pushes: log.length,
      stayedPlaying: log.length > 0 && log.every((x) => x.transport === 'playing'),
      transports: [...new Set(log.map((x) => x.transport))],
      positionAdvancedMs: before && after ? after.enginePositionMs - before.enginePositionMs : null,
      last: snap(after),
    };
  };

  const step = async (
    id: string,
    title: string,
    summary: string,
    fn: (rec: StepRecord) => Promise<void>,
    skipReason?: string | null,
  ): Promise<StepRecord> => {
    const rec: StepRecord = {
      id,
      title,
      result: 'pass',
      commands: [],
      observations: {},
      answers: {},
      notes: [],
    };
    report.steps.push(rec);
    if (aborted) {
      rec.result = 'not-run';
      return rec;
    }
    if (skipReason) {
      rec.result = 'skipped';
      rec.notes.push(skipReason);
      io.print(`\n[${id}] 跳过 / skipped: ${skipReason}`);
      return rec;
    }
    const c = await io.confirm(id, `${title} — ${summary}`);
    if (c === 'skip') {
      rec.result = 'skipped';
      return rec;
    }
    if (c === 'quit') {
      aborted = true;
      rec.result = 'not-run';
      return rec;
    }
    s.capture(rec.commands);
    try {
      await fn(rec);
    } catch (err) {
      rec.result = 'fail';
      rec.notes.push(s.redactor.apply(`${(err as Error).name}: ${(err as Error).message}`));
      if (err instanceof GateGuardError) throw err; // programming error: never continue
      if (err instanceof EngineUnavailableError || !s.connected) {
        aborted = true;
        io.print(
          '✘ 与 HQPlayer 的连接断开，停止后续步骤并尝试恢复。/ Connection lost; stopping and restoring.',
        );
      }
    } finally {
      s.capture(null);
    }
    io.print(
      `  → ${rec.result.toUpperCase()}${rec.notes.length ? ` (${rec.notes.join('; ')})` : ''}`,
    );
    return rec;
  };

  const yn = { y: '是 / yes', n: '否 / no' };

  // ---------------------------------------------------------------- W1: what Windows knows
  await step(
    'W1',
    'Windows 媒体信息 / Windows media sessions',
    '只读：查看 Windows 是否能看到 Apple Music 正在播放的曲目 / read-only: does Windows see what Apple Music is playing',
    async (rec) => {
      const sessions = await media.list();
      rec.observations.sessions = sessions.map(describeSession);
      const apple = sessions.find((m) => isAppleMusicApp(m.app)) ?? null;
      rec.observations.appleMusicFound = apple !== null;
      for (const m of sessions) {
        io.print(
          `    ${isAppleMusicApp(m.app) ? '★' : ' '} ${m.app} — ${m.status} — ${m.title || '（无标题 / no title）'} · ${m.artist || '?'} · ${m.album || '?'} · 封面 / cover ${m.thumbnailBytes > 0 ? `${m.thumbnailBytes} bytes` : '无 / none'}`,
        );
      }
      if (!apple) {
        check(rec, false, 'no Apple Music media session');
        io.print('    没有找到 Apple Music。/ Apple Music was not found among the sessions.');
        return;
      }
      appleApp = apple.app;
      if (
        (await ask(
          rec,
          'titleMatches',
          '上面带 ★ 的曲名，是 Apple Music 现在正在播放的吗？/ Is the ★ title what Apple Music is playing now?',
          yn,
        )) === 'n'
      )
        check(rec, false, 'listener: published title does not match');
    },
    media.supported ? null : '只在 Windows 上可用 / Windows only',
  );

  // ---------------------------------------------------------------- L1: stop
  await step(
    'L1',
    'Stop',
    '停止 HQPlayer 当前播放 / stop what HQPlayer is playing',
    async (rec) => {
      rec.observations.before = snap(s.status());
      playbackTouched = true;
      const r = await s.stopAndWait();
      rec.observations.msToStopped = r.ms;
      stopped = r.stopped;
      check(rec, r.stopped, 'state did not become stopped');
    },
    stopped ? '已经是停止状态 / already stopped' : null,
  );

  // ---------------------------------------------------------------- L2: load + play the live input
  await step(
    'L2',
    '载入并播放实时输入 / load and play the live input',
    `清空播放列表，加入一个实时输入条目并播放（结束时恢复原列表）/ clear the playlist, add ONE live-input entry and play it: ${candidates.join(' → ')}`,
    async (rec) => {
      const attempts: LiveAttempt[] = [];
      rec.observations.attempts = attempts;
      for (const uri of candidates) {
        const a: LiveAttempt = {
          uri,
          cleared: false,
          addAccepted: false,
          storedUri: null,
          storedLengthMs: null,
          playlistLength: null,
          playAccepted: null,
          reachedPlaying: null,
          msToPlaying: null,
          error: null,
        };
        attempts.push(a);
        playlistModified = true;
        await s.send('PlaylistClear');
        a.cleared = (await s.playlist()).entries.length === 0;
        if (!a.cleared) {
          check(rec, false, 'PlaylistClear left entries behind');
          break;
        }
        try {
          await s.send('PlaylistAdd', { uri, queued: 1, clear: 0 });
          a.addAccepted = true;
        } catch (err) {
          if (!(err instanceof EngineCommandError)) throw err;
          a.error = s.redactor.apply((err as Error).message).slice(0, 200);
          io.print(`    ${uri}: HQPlayer 不接受 / not accepted`);
          continue;
        }
        const after = (await s.playlist()).entries;
        const stored: PlaylistEntry | undefined = after[0];
        a.playlistLength = after.length;
        a.storedUri = stored?.uri
          ? isLiveUri(stored.uri)
            ? stored.uri
            : describeValue(stored.uri)
          : null;
        a.storedLengthMs = stored?.lengthMs ?? null;
        if (after.length !== 1) {
          a.error = `playlist has ${after.length} entries after one PlaylistAdd`;
          continue;
        }
        const started = Date.now();
        try {
          await s.send('SelectTrack', { index: stored?.engineIndex ?? 1 });
          await s.send('Play', { last: 0 });
          a.playAccepted = true;
        } catch (err) {
          if (!(err instanceof EngineCommandError)) throw err;
          a.playAccepted = false;
          a.error = s.redactor.apply((err as Error).message).slice(0, 200);
          io.print(`    ${uri}: 无法播放 / could not start`);
          continue;
        }
        playbackTouched = true;
        const playing = await s.waitFor((x) => x.transport === 'playing', 10000);
        a.reachedPlaying = playing !== null;
        a.msToPlaying = playing ? Date.now() - started : null;
        if (playing) {
          chosen = uri;
          stopped = false;
          io.print(`    ${uri}: 正在播放 / playing`);
          break;
        }
        io.print(`    ${uri}: 没有进入播放状态 / did not reach "playing"`);
        stopped = (await s.stopAndWait()).stopped;
        if (!stopped) {
          check(rec, false, 'engine did not stop after a failed attempt');
          break;
        }
      }
      rec.observations.chosen = chosen;
      rec.observations.status = s.statusRaw();
      check(rec, chosen !== null, 'no live-input URI could be played');
    },
    stopped ? null : 'HQPlayer 没有停止（L1 未完成）/ HQPlayer is not stopped (L1 not done)',
  );

  const notPlayingLive = () =>
    chosen === null ? '实时输入没有播放起来 / the live input is not playing' : null;

  // ---------------------------------------------------------------- L3: listen
  await step(
    'L3',
    '听 15 秒 / listen for 15 seconds',
    '确认 Apple Music 的声音经 HQPlayer 从 DAC 出来 / is Apple Music coming out of the DAC through HQPlayer',
    async (rec) => {
      rec.observations.watch = await watch(15000);
      rec.observations.status = s.statusRaw();
      if (
        (await ask(
          rec,
          'heard',
          '听到 Apple Music 的声音了吗（经过 HQPlayer / DAC）？/ Do you hear Apple Music through the DAC?',
          yn,
        )) === 'n'
      ) {
        check(rec, false, 'listener heard nothing');
        return;
      }
      const quality = await ask(rec, 'quality', '声音怎么样？/ How does it sound?', {
        c: '干净 / clean',
        d: '有断续或咔哒声 / dropouts or clicks',
        n: '有噪声或失真 / noise or distortion',
      });
      if (quality !== 'c') check(rec, false, `listener: ${quality === 'd' ? 'dropouts' : 'noise'}`);
      if ((await ask(rec, 'pitch', '音调和速度正常吗？/ Are pitch and speed normal?', yn)) === 'n')
        check(rec, false, 'listener: wrong pitch or speed (rate mismatch)');
    },
    notPlayingLive(),
  );

  // ---------------------------------------------------------------- W2: control Apple Music
  await step(
    'W2',
    '暂停 / 继续 Apple Music',
    '通过 Windows 让 Apple Music 暂停约 8 秒再继续（不碰 HQPlayer）/ pause Apple Music through Windows for ~8 s, then resume (HQPlayer untouched)',
    async (rec) => {
      const app = appleApp;
      if (app === null) return;
      try {
        const paused = await media.control(app, 'pause');
        rec.observations.pauseAccepted = paused;
        check(rec, paused, 'Windows reported the pause was not accepted');
        rec.observations.duringPause = await watch(8000);
        if (
          (await ask(
            rec,
            'paused',
            'Apple Music 暂停了吗（几秒后声音也停了）？/ Did Apple Music pause (and the sound stop a few seconds later)?',
            yn,
          )) === 'n'
        )
          check(rec, false, 'listener: Apple Music did not pause');
      } finally {
        // Always ask Apple Music to carry on, whatever happened above.
        rec.observations.playAccepted = await media.control(app, 'play').catch(() => false);
      }
      rec.observations.afterResume = await watch(6000);
      if (
        (await ask(
          rec,
          'resumed',
          'Apple Music 继续播放、声音回来了吗？/ Did Apple Music resume and the sound come back?',
          yn,
        )) === 'n'
      )
        check(rec, false, 'listener: sound did not come back');
    },
    notPlayingLive() ??
      (appleApp === null
        ? '没有 Apple Music 的媒体信息（W1）/ no Apple Music media session (W1)'
        : null),
  );

  // ---------------------------------------------------------------- L4: one minute
  await step(
    'L4',
    '连续听 60 秒 / listen for 60 seconds',
    '看一分钟内是否稳定 / is it stable for a minute',
    async (rec) => {
      const w = await watch(60000);
      rec.observations.watch = w;
      check(rec, w.stayedPlaying, 'engine left "playing" during the minute');
      if (
        (await ask(
          rec,
          'dropouts',
          '这一分钟里有断续、咔哒声或噪声吗？/ Any dropouts, clicks or noise in this minute?',
          { n: '没有 / none', y: '有 / yes' },
        )) === 'y'
      )
        check(rec, false, 'listener: dropouts in the minute');
    },
    notPlayingLive(),
  );

  // ---------------------------------------------------------------- L5: stop and start again
  await step(
    'L5',
    '停止再播放 / stop, then play again',
    '停止实时输入，再重新开始（Studio 切换来源时会这样做）/ stop the live input and start it again',
    async (rec) => {
      const r = await s.stopAndWait();
      rec.observations.msToStopped = r.ms;
      stopped = r.stopped;
      check(rec, r.stopped, 'state did not become stopped');
      if (!r.stopped) return;
      const started = Date.now();
      await s.send('Play', { last: 0 });
      const playing = await s.waitFor((x) => x.transport === 'playing', 10000);
      rec.observations.msToPlaying = playing ? Date.now() - started : null;
      stopped = playing === null;
      check(rec, playing !== null, 'state did not become playing again');
      if (!playing) return;
      await s.sleep(6000);
      if ((await ask(rec, 'heardAgain', '声音又回来了吗？/ Is the sound back?', yn)) === 'n')
        check(rec, false, 'listener heard nothing after restart');
    },
    notPlayingLive(),
  );

  // ---------------------------------------------------------------- L6: restore
  report.restore.needed = playlistModified;
  report.aborted = aborted;
  const restoreRec: StepRecord = {
    id: 'L6',
    title: 'Restore',
    result: 'pass',
    commands: [],
    observations: {},
    answers: {},
    notes: [],
  };
  report.steps.push(restoreRec);
  if (!s.connected) {
    restoreRec.result = 'fail';
    restoreRec.notes.push('not connected');
  } else if (playlistModified || playbackTouched) {
    let go =
      (await io.confirm('L6', '恢复原播放列表（按回车开始）/ restore the original playlist')) !==
      'skip';
    if (!go) {
      go =
        (await io.ask('确定不恢复吗？/ Really skip the restore?', {
          n: '不，恢复 / no, restore',
          y: '确定跳过 / yes, skip',
        })) !== 'y';
    }
    if (go) {
      s.capture(restoreRec.commands);
      try {
        await restore(s, backup, restoreUris, playlistModified, report, io);
      } catch (err) {
        restoreRec.result = 'fail';
        restoreRec.notes.push(s.redactor.apply((err as Error).message));
      } finally {
        s.capture(null);
      }
      if (report.restore.verified === false) restoreRec.result = 'fail';
      // Keep the step log compact: summarise the long run of PlaylistAdd commands.
      const adds = restoreRec.commands.filter((c) => c.name === 'PlaylistAdd');
      restoreRec.observations.playlistAdds = {
        sent: adds.length,
        failed: adds.filter((c) => !c.ok).length,
      };
      restoreRec.commands = restoreRec.commands
        .filter((c) => c.name !== 'PlaylistAdd')
        .concat(adds.slice(0, 2));
    } else {
      restoreRec.result = 'skipped';
      restoreRec.notes.push('user skipped restore');
    }
  } else {
    restoreRec.result = 'skipped';
    restoreRec.notes.push('nothing to restore (playlist unchanged)');
  }

  if (report.restore.verified === false || (playlistModified && !report.restore.performed)) {
    io.print('\n⚠ 播放列表没有完全恢复。请在 HQPlayer 中打开下面的备份播放列表：');
    io.print('  The playlist was not fully restored. Open this backup in HQPlayer:');
    io.print(`    ${backupPaths.m3u8}`);
  }

  report.findings = buildFindings(report);
  s.close();
  return { report, backup: backupPaths, exitCode: 0 };
}

async function restore(
  s: LiveGateSession,
  backup: BackupFile,
  restoreUris: (string | null)[],
  playlistModified: boolean,
  report: LiveGateReport,
  io: GateIO,
): Promise<void> {
  // Never clear before the engine has really stopped: a clear during playback keeps the
  // playing entry, and here that entry would be the live input.
  const stop = await s.stopAndWait();
  if (!stop.stopped) report.restore.notes.push('engine did not report "stopped" before the clear');
  if (playlistModified) {
    await s.send('PlaylistClear');
    const left = (await s.playlist()).entries.length;
    if (left !== 0) report.restore.notes.push(`${left} entries left after PlaylistClear`);
    let n = 0;
    for (const uri of restoreUris) {
      if (!uri) continue;
      try {
        await s.send('PlaylistAdd', { uri, queued: 1, clear: 0 });
      } catch (err) {
        if (!(err instanceof EngineCommandError)) throw err;
      }
      n++;
      if (n % 10 === 0) io.print(`  恢复中 / restoring… ${n}/${restoreUris.length}`);
    }
    report.restore.performed = true;
    const after = (await s.playlist()).entries;
    report.restore.actual = after.length;
    const mismatched: number[] = [];
    backup.entries.forEach((e, i) => {
      const a: PlaylistEntry | undefined = after[i];
      const want = restoreUris[i];
      const same =
        !!want && !!a?.uri && (a.uri === e.uri || a.uri === want || sameEnginePath(a.uri, want));
      if (!same) mismatched.push(i + 1);
    });
    report.restore.mismatchedPositions = mismatched;
    report.restore.verified = after.length === backup.entries.length && mismatched.length === 0;
  }
  if (backup.currentEngineIndex !== null) {
    try {
      await s.send('SelectTrack', { index: backup.currentEngineIndex });
      report.restore.reselected = true;
    } catch {
      report.restore.reselected = false;
    }
  }
  io.print(
    report.restore.verified === false
      ? `  ✘ 恢复核对失败 / restore check failed (${report.restore.actual}/${report.restore.expected})`
      : `  ✔ 已恢复 / restored${report.restore.performed ? ` ${report.restore.actual}/${report.restore.expected}` : ''}（未自动播放 / not playing）`,
  );
}

function buildFindings(report: LiveGateReport): Record<string, unknown> {
  const by = (id: string) => report.steps.find((x) => x.id === id);
  const r = (id: string) => by(id)?.result ?? 'not-run';
  const o = (id: string, key: string) => by(id)?.observations[key];
  const attempts = (o('L2', 'attempts') as LiveAttempt[] | undefined) ?? [];
  const winner = attempts.find((a) => a.reachedPlaying) ?? null;
  return {
    'inputs.listedLiveUris': report.inputs.listedLiveUris,
    'live.load+play': r('L2'),
    'live.uri': o('L2', 'chosen') ?? null,
    'live.storedUri': winner?.storedUri ?? null,
    'live.storedLengthMs': winner?.storedLengthMs ?? null,
    'live.msToPlaying': winner?.msToPlaying ?? null,
    'live.rejectedUris': attempts.filter((a) => !a.reachedPlaying).map((a) => a.uri),
    'live.heard': {
      result: r('L3'),
      heard: by('L3')?.answers.heard ?? null,
      quality: by('L3')?.answers.quality ?? null,
      pitch: by('L3')?.answers.pitch ?? null,
    },
    'live.stableOneMinute': { result: r('L4'), dropouts: by('L4')?.answers.dropouts ?? null },
    'live.stop+restart': {
      result: r('L5'),
      msToStopped: o('L5', 'msToStopped') ?? null,
      msToPlaying: o('L5', 'msToPlaying') ?? null,
    },
    'windows.appleMusicSession': {
      result: r('W1'),
      found: o('W1', 'appleMusicFound') ?? null,
      titleMatches: by('W1')?.answers.titleMatches ?? null,
    },
    'windows.appleMusicControl': {
      result: r('W2'),
      pauseAccepted: o('W2', 'pauseAccepted') ?? null,
      playAccepted: o('W2', 'playAccepted') ?? null,
    },
    restore: { needed: report.restore.needed, verified: report.restore.verified },
  };
}
