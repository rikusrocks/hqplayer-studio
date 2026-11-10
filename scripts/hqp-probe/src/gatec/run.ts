import os from 'node:os';
import { engineUriToPath, sameEnginePath } from '@hqps/contracts';
import { EngineCommandError, EngineUnavailableError } from '@hqps/hqplayer-adapter';
import { scrubPaths } from '../sanitize';
import {
  labelUri,
  selectTestFiles,
  storedForm,
  writeBackup,
  type BackupFile,
  type TestFiles,
} from './files';
import {
  GateCSession,
  GateGuardError,
  type CommandLog,
  type LiveStatus,
  type PlaylistEntry,
} from './session';

export const GATEC_VERSION = '0.1.0';
export const GATEC_SCHEMA = 'hqps.gatec.v1';

export type StepAnswer = 'go' | 'skip' | 'quit';

/** Console abstraction so the whole run can be scripted in tests. */
export interface GateIO {
  print(text: string): void;
  /** Before every step: Enter = go, s = skip, q = abort (→ restore). */
  confirm(id: string, summary: string): Promise<StepAnswer>;
  /** Listener observation; returns one of the choice keys. */
  ask(question: string, choices: Record<string, string>): Promise<string>;
  text(question: string): Promise<string>;
}

export interface StepRecord {
  id: string;
  title: string;
  result: 'pass' | 'fail' | 'info' | 'skipped' | 'not-run';
  commands: CommandLog[];
  observations: Record<string, unknown>;
  answers: Record<string, string>;
  notes: string[];
}

export interface GateCReport {
  schema: typeof GATEC_SCHEMA;
  toolVersion: string;
  generatedAt: string;
  plan: string;
  sanitized: true;
  environment: { platform: string; release: string; arch: string };
  engine: Record<string, string | null> | null;
  reachable: boolean;
  aborted: boolean;
  start: Record<string, unknown> | null;
  steps: StepRecord[];
  restore: {
    needed: boolean;
    performed: boolean;
    verified: boolean | null;
    form: 'native' | 'file' | null;
    expected: number;
    actual: number | null;
    mismatchedPositions: number[];
    reselected: boolean | null;
    notes: string[];
  };
  findings: Record<string, unknown>;
}

export interface GateCOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  timeScale?: number;
  outDir: string;
  io: GateIO;
  stamp: string;
}

/** Remove anything that looks like a local path/URI from free text (errors from HQPlayer). */
export function scrub(text: string): string {
  return scrubPaths(text);
}

export async function runGateC(o: GateCOptions): Promise<{
  report: GateCReport;
  backup: { json: string; m3u8: string } | null;
  exitCode: number;
}> {
  const { io } = o;
  const s = new GateCSession({
    host: o.host ?? '127.0.0.1',
    port: o.port ?? 4321,
    timeoutMs: o.timeoutMs,
    timeScale: o.timeScale,
  });
  const report: GateCReport = {
    schema: GATEC_SCHEMA,
    toolVersion: GATEC_VERSION,
    generatedAt: new Date().toISOString(),
    plan: 'docs/gate-c-plan.md — approved 2026-11-10: C1–C4, O1 Repeat/Random, O2 Volume (same level), local backup only',
    sanitized: true,
    environment: { platform: process.platform, release: os.release(), arch: process.arch },
    engine: null,
    reachable: false,
    aborted: false,
    start: null,
    steps: [],
    restore: {
      needed: false,
      performed: false,
      verified: null,
      form: null,
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

  // ---------------------------------------------------------------- C0: read-only backup
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
  const backupPaths = writeBackup(o.outDir, backup, o.stamp);
  for (const e of pl0.entries) s.redactor.add(e.uri, e.uri ? engineUriToPath(e.uri) : null);
  report.start = {
    transport: st0.transport,
    playlistLength: pl0.entries.length,
    albumMode: pl0.albumMode,
    currentEngineIndex,
    repeat: backup.repeat,
    random: backup.random,
    outputDelayMs: status0?.outputDelayMs ?? null,
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

  const startAnswer = await io.ask('开始 Gate C 测试？/ Start Gate C now?', {
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
  let connectionLost = false;
  let playlistModified = false;
  let selectionChanged = false;
  let nativeWorks: boolean | null = null;
  let fileFormWorks: boolean | null = null;
  let files: TestFiles | null = null;

  const label = (uri: string | null | undefined) => labelUri(uri ?? null, files, backup);
  const snap = (st: LiveStatus | null) =>
    st && {
      transport: st.transport,
      track: st.track,
      uri: label(st.uri),
      positionMs: st.positionMs,
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
        connectionLost = true;
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
  const hasPlaylist = pl0.entries.length > 0;

  // ---------------------------------------------------------------- C1: transport on existing playlist
  await step(
    'C1.1',
    'Play',
    '从当前曲目开始/继续播放 / start playback',
    async (rec) => {
      rec.observations.before = snap(s.status());
      await s.send('Play', { last: 0 });
      selectionChanged = true;
      const playing = await s.waitFor((x) => x.transport === 'playing', 6000);
      await s.sleep(3000);
      const after = s.status();
      rec.observations.after = snap(after);
      rec.observations.positionAdvanced = !!(
        playing &&
        after &&
        after.enginePositionMs > playing.enginePositionMs
      );
      check(rec, playing !== null, 'state did not become playing');
      if ((await ask(rec, 'heard', '听到声音了吗？/ Do you hear music?', yn)) === 'n')
        check(rec, false, 'listener heard nothing');
    },
    hasPlaylist ? null : 'HQPlayer 播放列表为空 / playlist empty',
  );

  await step(
    'C1.2',
    'Pause ×2',
    '第一次暂停；第二次看是恢复还是保持暂停 / pause twice',
    async (rec) => {
      await s.send('Pause');
      const paused = await s.waitFor((x) => x.transport !== 'playing', 4000);
      await s.sleep(1500);
      rec.observations.afterFirst = snap(s.status());
      check(rec, paused !== null, 'first Pause did not stop playback');
      await ask(rec, 'stoppedAfterFirst', '声音停了吗？/ Did the sound stop?', yn);
      const pausedAt = s.status()?.enginePositionMs ?? 0;
      await s.send('Pause');
      await s.sleep(2500);
      const second = s.status();
      rec.observations.afterSecond = snap(second);
      const toggles = second?.transport === 'playing';
      rec.observations.pauseSemantics = toggles
        ? 'toggle'
        : second?.transport === 'paused'
          ? 'idempotent'
          : (second?.transport ?? 'unknown');
      if (!toggles) {
        await s.send('Play', { last: 0 });
        const resumed = await s.waitFor((x) => x.transport === 'playing', 5000);
        rec.observations.playAfterPause = snap(resumed);
        rec.observations.playResumesPosition = resumed
          ? resumed.enginePositionMs >= pausedAt - 1500
          : null;
        check(rec, resumed !== null, 'Play did not resume after Pause');
      }
      await ask(rec, 'resumed', '声音恢复了吗？/ Is the music playing again?', {
        y: '是，从暂停处继续 / yes, same spot',
        r: '是，但从头开始 / yes, restarted',
        n: '否 / no',
      });
    },
    hasPlaylist ? null : 'playlist empty',
  );

  await step(
    'C1.3',
    'Seek 60 s',
    '跳到 1:00 / jump to 1:00',
    async (rec) => {
      const cur = s.status();
      if (!cur?.durationMs || cur.durationMs < 90_000) {
        rec.result = 'info';
        rec.notes.push('current track shorter than 90 s; seek not tested');
        return;
      }
      rec.observations.before = snap(cur);
      const t0 = Date.now();
      await s.send('Seek', { position: 60 });
      const engineAt = await s.waitFor((x) => Math.abs(x.enginePositionMs - 60_000) < 5000, 6000);
      rec.observations.engineAfterSeek = snap(engineAt);
      const audible = await s.waitFor((x) => x.positionMs >= 58_000, 15_000);
      rec.observations.audibleAfterSeek = snap(audible);
      rec.observations.msUntilAudibleAt60 = audible
        ? Math.round((Date.now() - t0) / s.timeScale)
        : null;
      check(rec, engineAt !== null, 'engine position did not move to ~60 s');
      if (
        (await ask(
          rec,
          'heardJump',
          '是否从约 1:00 继续播放？/ Did it continue from about 1:00?',
          yn,
        )) === 'n'
      )
        check(rec, false, 'listener did not hear the jump');
    },
    hasPlaylist ? null : 'playlist empty',
  );

  await step(
    'C1.4',
    'Next / Previous',
    '下一首，然后在曲中按上一首 / next, then previous mid-track',
    async (rec) => {
      const before = s.status();
      rec.observations.before = snap(before);
      await s.send('Next');
      const moved = await s.waitFor(
        (x) => x.uri !== before?.uri || x.track !== before?.track,
        6000,
      );
      rec.observations.afterNext = snap(moved);
      check(rec, moved !== null, 'Next did not change track');
      if (moved?.durationMs && moved.durationMs > 40_000) {
        await s.send('Seek', { position: 20 });
        await s.waitFor((x) => x.enginePositionMs >= 18_000, 5000);
        await s.sleep(1000);
      }
      const mid = s.status();
      await s.send('Previous');
      await s.sleep(3000);
      const after = s.status();
      rec.observations.afterPrevious = snap(after);
      // Compare with the position just before Previous (independent of playback speed/delay).
      rec.observations.previousBehaviour =
        after?.uri === mid?.uri
          ? after && mid && after.enginePositionMs < mid.enginePositionMs - 5000
            ? 'restart-current'
            : 'no-change'
          : after?.uri === before?.uri
            ? 'previous-track'
            : 'other';
    },
    hasPlaylist ? null : 'playlist empty',
  );

  await step(
    'C1.5',
    'Stop',
    '停止 / stop',
    async (rec) => {
      await s.send('Stop');
      const stopped = await s.waitFor((x) => x.transport === 'stopped', 5000);
      rec.observations.after = snap(stopped ?? s.status());
      check(rec, stopped !== null, 'state did not become stopped');
      await ask(rec, 'silent', '声音停止了吗？/ Is it silent now?', yn);
    },
    hasPlaylist ? null : 'playlist empty',
  );

  // ---------------------------------------------------------------- O1 / O2
  await step(
    'O1',
    'Repeat / Random',
    '各切换一次再恢复为原值 / toggle once, then restore',
    async (rec) => {
      const orig = await s.state();
      const origRepeat = orig.raw.repeat ?? '0';
      const origRandom = orig.raw.random ?? '0';
      const repeatTarget = origRepeat === '2' ? 0 : 2;
      await s.send('SetRepeat', { value: repeatTarget });
      rec.observations.repeatAfterSet = (await s.state()).raw.repeat ?? null;
      await s.send('SetRepeat', { value: Number(origRepeat) });
      const r2 = (await s.state()).raw.repeat ?? null;
      rec.observations.repeatRestored = r2 === origRepeat;
      const randomTarget = origRandom === '1' ? 0 : 1;
      await s.send('SetRandom', { value: randomTarget });
      rec.observations.randomAfterSet = (await s.state()).raw.random ?? null;
      await s.send('SetRandom', { value: Number(origRandom) });
      const d2 = (await s.state()).raw.random ?? null;
      rec.observations.randomRestored = d2 === origRandom;
      check(
        rec,
        rec.observations.repeatAfterSet === String(repeatTarget),
        'SetRepeat had no effect',
      );
      check(
        rec,
        rec.observations.randomAfterSet === String(randomTarget),
        'SetRandom had no effect',
      );
      check(rec, r2 === origRepeat && d2 === origRandom, 'could not restore repeat/random');
    },
  );

  await step(
    'O2',
    'Volume (same level)',
    `设为当前音量 ${backup.volume ?? '?'} dB，不会调大 / same level only`,
    async (rec) => {
      const st = await s.state();
      const v = st.raw.volume ?? null;
      if (v === null) {
        rec.result = 'info';
        rec.notes.push('volume not reported');
        return;
      }
      s.permitVolume(v);
      try {
        await s.send('Volume', { value: v });
        rec.observations.accepted = true;
      } catch (err) {
        if (!(err instanceof EngineCommandError)) throw err;
        rec.observations.accepted = false;
        rec.result = 'info';
        rec.notes.push(s.redactor.apply(err.message));
      } finally {
        s.permitVolume(null);
      }
      rec.observations.volumeUnchanged = (await s.state()).raw.volume === v;
      await ask(rec, 'levelChanged', '音量有变化吗？/ Did the level change?', {
        n: '没有 / no',
        y: '有 / yes',
      });
    },
  );

  // ---------------------------------------------------------------- test folder
  if (!aborted) {
    for (let attempt = 0; attempt < 3 && !files; attempt++) {
      const raw = (
        await io.text(
          '请输入测试文件夹路径（直接回车 = 跳过 C2–C3，不改动播放列表）\nTest folder path (Enter = skip C2–C3):',
        )
      )
        .trim()
        .replace(/^"(.*)"$/, '$1');
      if (!raw) break;
      try {
        files = selectTestFiles(raw);
      } catch (err) {
        io.print(`  ✘ ${(err as Error).message}`);
      }
    }
    if (files) {
      s.redactor.add(files.folder, ...files.pcm, files.dsd, ...files.names.pcm, files.names.dsd);
      io.print('  将使用 / will use:');
      files.names.pcm.forEach((n, i) => io.print(`    T${i + 1}: ${n}`));
      io.print(`    DSD: ${files.names.dsd ?? '（无 / none）'}`);
      if ((await io.ask('确认用这些文件？/ Use these files?', yn)) !== 'y') files = null;
    }
  }
  const noFiles = files ? null : '未提供测试文件夹 / no test folder';
  const tf = () => files as TestFiles;

  // ---------------------------------------------------------------- C2: loading
  await step(
    'C2.1',
    'PlaylistClear',
    '清空 HQPlayer 播放列表（已备份）/ clear playlist (backed up)',
    async (rec) => {
      if (s.status()?.transport !== 'stopped') await s.send('Stop');
      playlistModified = true;
      await s.send('PlaylistClear');
      const pl = await s.playlist();
      rec.observations.count = pl.entries.length;
      check(rec, pl.entries.length === 0, 'playlist not empty after PlaylistClear');
    },
    noFiles,
  );

  await step(
    'C2.2',
    'PlaylistAdd ×3 (native path)',
    '加入 T1–T3（原生路径）/ add T1–T3 as native paths',
    async (rec) => {
      playlistModified = true;
      const results: unknown[] = [];
      let ok = true;
      for (let i = 0; i < 3; i++) {
        const path = tf().pcm[i] as string;
        const before = (await s.playlist()).entries.length;
        let accepted = true;
        try {
          await s.send('PlaylistAdd', { uri: path, queued: 1, clear: 0 });
        } catch (err) {
          if (!(err instanceof EngineCommandError)) throw err;
          accepted = false;
        }
        const after = (await s.playlist()).entries;
        const last = after.at(-1);
        const added = after.length === before + 1 && !!last?.uri && sameEnginePath(last.uri, path);
        ok &&= added;
        results.push({
          file: `T${i + 1}`,
          accepted,
          added,
          count: after.length,
          storedForm: storedForm(last?.uri ?? null, path),
        });
      }
      rec.observations.adds = results;
      nativeWorks = ok;
      check(rec, ok, 'native paths were not all added');
    },
    noFiles,
  );

  await step(
    'C2.3',
    'PlaylistAdd file:// form',
    '用 file:// 形式再加入 T1 / add T1 again as file:// URI',
    async (rec) => {
      playlistModified = true;
      const path = tf().pcm[0];
      const sent = `file://${path}`;
      const before = (await s.playlist()).entries.length;
      let accepted = true;
      try {
        await s.send('PlaylistAdd', { uri: sent, queued: 1, clear: 0 });
      } catch (err) {
        if (!(err instanceof EngineCommandError)) throw err;
        accepted = false;
      }
      const after = (await s.playlist()).entries;
      const last = after.at(-1);
      fileFormWorks = after.length === before + 1 && !!last?.uri && sameEnginePath(last.uri, path);
      rec.observations.result = {
        accepted,
        added: fileFormWorks,
        count: after.length,
        storedForm: storedForm(last?.uri ?? null, sent),
      };
      if (!fileFormWorks) {
        rec.result = 'info';
        rec.notes.push('file:// form not added (native form is used for restore)');
      }
    },
    noFiles,
  );

  await step(
    'C2.4',
    'SelectTrack 2 + Play',
    '选中第 2 项并播放 / select item 2 and play',
    async (rec) => {
      selectionChanged = true;
      const pl = (await s.playlist()).entries;
      rec.observations.playlistLabels = pl.map((e) => label(e.uri));
      await s.send('SelectTrack', { index: 2 });
      await s.send('Play', { last: 0 });
      const st = await s.waitFor((x) => x.transport === 'playing' && !!x.uri, 6000);
      rec.observations.playing = snap(st);
      const entry = pl.find((e) => st?.uri && e.uri === st.uri);
      rec.observations.playingEngineIndex = entry?.engineIndex ?? null;
      rec.observations.selectTrackBase = entry ? 2 - (entry.engineIndex - 1) : null; // 1 → 1-based
      rec.observations.statusTrackEqualsEngineIndex = entry
        ? st?.track === entry.engineIndex
        : null;
      check(rec, label(st?.uri) === 'T2', `expected T2, got ${label(st?.uri)}`);
      if (
        (await ask(
          rec,
          'isT2',
          `正在播放的是 T2「${tf().names.pcm[1]}」吗？/ Is T2 playing?`,
          yn,
        )) === 'n'
      )
        check(rec, false, 'listener says not T2');
    },
    noFiles,
  );

  await step(
    'C2.5',
    'PlaylistRemove 4',
    '删除第 4 项（file:// 重复的 T1）/ remove item 4',
    async (rec) => {
      const before = (await s.playlist()).entries;
      const target = before.find((e) => e.engineIndex === 4);
      rec.observations.before = before.map((e) => label(e.uri));
      await s.send('PlaylistRemove', { index: 4 });
      const after = (await s.playlist()).entries;
      rec.observations.after = after.map((e) => label(e.uri));
      const stillThere = target
        ? after.some((e) => e.engineIndex === target.engineIndex && e.uri === target.uri)
        : false;
      rec.observations.removedIntended =
        !!target && after.length === before.length - 1 && !stillThere;
      check(
        rec,
        rec.observations.removedIntended === true,
        'PlaylistRemove index=4 did not remove item 4',
      );
    },
    noFiles,
  );

  await step(
    'C2.6',
    'PlaylistAdd clear=1 queued=0',
    '用 clear=1 queued=0 加入 T3，看是否清空并立即播放 / semantics check',
    async (rec) => {
      await s.send('Stop');
      await s.waitFor((x) => x.transport === 'stopped', 4000);
      await s.send('PlaylistAdd', { uri: tf().pcm[2], clear: 1, queued: 0 });
      await s.sleep(3000);
      const pl = (await s.playlist()).entries;
      const st = s.status();
      rec.observations.playlistLabels = pl.map((e) => label(e.uri));
      rec.observations.after = snap(st);
      rec.observations.cleared = pl.length === 1;
      rec.observations.startedPlaying = st?.transport === 'playing';
      rec.result = 'info';
      await ask(
        rec,
        'startedImmediately',
        '是否立刻开始播放了？/ Did it start playing immediately?',
        yn,
      );
      await s.send('Stop');
    },
    noFiles,
  );

  // ---------------------------------------------------------------- C3: formats & gapless
  await step(
    'C3.1',
    'DSF playback',
    '装载并播放 DSD 文件 / load and play the DSD file',
    async (rec) => {
      await s.send('Stop');
      await s.send('PlaylistClear');
      await s.send('PlaylistAdd', { uri: tf().dsd as string, queued: 1, clear: 0 });
      await s.send('SelectTrack', { index: 1 });
      await s.send('Play', { last: 0 });
      const st = await s.waitFor((x) => x.transport === 'playing', 8000);
      await s.sleep(3000);
      rec.observations.playing = snap(s.status());
      check(rec, st !== null && label(s.status()?.uri) === 'DSD', 'DSD file did not play');
      if ((await ask(rec, 'ok', '播放正常吗？/ Does it play normally?', yn)) === 'n')
        check(rec, false, 'listener reports a problem');
      await s.send('Stop');
    },
    noFiles ?? (files?.dsd ? null : '测试文件夹里没有 DSF/DFF / no DSD file'),
  );

  await step(
    'C3.2',
    'Gapless T1 → T2',
    '播放 T1 结尾前 15 秒，听换到 T2 / listen to the T1→T2 transition',
    async (rec) => {
      await s.send('Stop');
      await s.send('PlaylistClear');
      await s.send('PlaylistAdd', { uri: tf().pcm[0], queued: 1, clear: 0 });
      await s.send('PlaylistAdd', { uri: tf().pcm[1], queued: 1, clear: 0 });
      const pl = (await s.playlist()).entries;
      const len1 = pl[0]?.lengthMs ?? null;
      await s.send('SelectTrack', { index: 1 });
      await s.send('Play', { last: 0 });
      await s.waitFor((x) => x.transport === 'playing', 6000);
      if (len1 && len1 > 30_000) {
        const target = Math.floor(len1 / 1000) - 15;
        await s.send('Seek', { position: target });
        await s.waitFor((x) => x.enginePositionMs >= (target - 2) * 1000, 6000);
      }
      const seen = new Set<string>();
      const reached = await s.waitFor((x) => {
        seen.add(x.transport);
        return label(x.uri) === 'T2';
      }, 40_000);
      rec.observations.reachedT2 = reached !== null;
      rec.observations.transportsSeenDuringSwitch = [...seen];
      rec.observations.afterSwitch = snap(reached);
      check(rec, reached !== null, 'did not advance to T2');
      await ask(rec, 'transition', '换曲时听感？/ How was the transition?', {
        g: '无缝 / gapless',
        c: '有咔声 / click',
        s: '有静音 / silence gap',
        u: '没注意到 / not sure',
      });
      await s.send('Stop');
    },
    noFiles,
  );

  // ---------------------------------------------------------------- C4: restore
  if (connectionLost) {
    try {
      await s.open();
      connectionLost = false;
      io.print('✔ 已重新连接，开始恢复。/ Reconnected; restoring.');
    } catch {
      report.restore.notes.push('could not reconnect for restore');
    }
  }
  report.aborted = aborted;
  report.restore.needed = playlistModified;
  report.restore.expected = backup.entries.length;
  const restoreRec: StepRecord = {
    id: 'C4',
    title: 'Restore playlist',
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
  } else if (playlistModified || selectionChanged) {
    let go =
      (await io.confirm('C4', '恢复原播放列表（按回车开始）/ restore the original playlist')) !==
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
        await restore(
          s,
          backup,
          playlistModified,
          nativeWorks === false && fileFormWorks === true ? 'file' : 'native',
          report,
          io,
        );
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

  report.findings = buildFindings(report, nativeWorks, fileFormWorks);
  s.close();
  return { report, backup: backupPaths, exitCode: 0 };
}

async function restore(
  s: GateCSession,
  backup: BackupFile,
  playlistModified: boolean,
  form: 'native' | 'file',
  report: GateCReport,
  io: GateIO,
): Promise<void> {
  try {
    await s.send('Stop');
  } catch {
    // keep going
  }
  if (playlistModified) {
    report.restore.form = form;
    await s.send('PlaylistClear');
    const paths = backup.entries.map((e) => (e.uri ? engineUriToPath(e.uri) : null));
    let n = 0;
    for (const path of paths) {
      if (!path) continue;
      try {
        await s.send('PlaylistAdd', {
          uri: form === 'native' ? path : `file://${path}`,
          queued: 1,
          clear: 0,
        });
      } catch (err) {
        if (!(err instanceof EngineCommandError)) throw err;
      }
      n++;
      if (n % 10 === 0) io.print(`  恢复中 / restoring… ${n}/${paths.length}`);
    }
    report.restore.performed = true;
    const after = (await s.playlist()).entries;
    report.restore.actual = after.length;
    const mismatched: number[] = [];
    paths.forEach((p, i) => {
      const a: PlaylistEntry | undefined = after[i];
      if (!p || !a?.uri || !sameEnginePath(a.uri, p)) mismatched.push(i + 1);
    });
    report.restore.mismatchedPositions = mismatched;
    report.restore.verified = after.length === paths.length && mismatched.length === 0;
  }
  if (backup.currentEngineIndex !== null) {
    try {
      await s.send('SelectTrack', { index: backup.currentEngineIndex });
      report.restore.reselected = true;
    } catch {
      report.restore.reselected = false;
    }
  }
  // Repeat/random back to the original values (O1 restores already; this is a safety net).
  const now = await s.state();
  if (backup.repeat !== null && now.raw.repeat !== backup.repeat)
    await s.send('SetRepeat', { value: Number(backup.repeat) });
  if (backup.random !== null && now.raw.random !== backup.random)
    await s.send('SetRandom', { value: Number(backup.random) });
  io.print(
    report.restore.verified === false
      ? `  ✘ 恢复核对失败 / restore check failed (${report.restore.actual}/${report.restore.expected})`
      : `  ✔ 已恢复 / restored${report.restore.performed ? ` ${report.restore.actual}/${report.restore.expected}` : ''}（未自动播放 / not playing）`,
  );
}

function buildFindings(
  report: GateCReport,
  nativeWorks: boolean | null,
  fileFormWorks: boolean | null,
): Record<string, unknown> {
  const by = (id: string) => report.steps.find((x) => x.id === id);
  const r = (id: string) => by(id)?.result ?? 'not-run';
  const o = (id: string, key: string) => by(id)?.observations[key];
  return {
    'transport.play': r('C1.1'),
    'transport.pause': {
      result: r('C1.2'),
      semantics: o('C1.2', 'pauseSemantics') ?? null,
      playResumesPosition: o('C1.2', 'playResumesPosition') ?? null,
    },
    'transport.seek': {
      result: r('C1.3'),
      msUntilAudibleAt60: o('C1.3', 'msUntilAudibleAt60') ?? null,
    },
    'transport.next': r('C1.4'),
    'transport.previous': { behaviour: o('C1.4', 'previousBehaviour') ?? null },
    'transport.stop': r('C1.5'),
    'playback.repeat+random': r('O1'),
    'volume.set': {
      result: r('O2'),
      accepted: o('O2', 'accepted') ?? null,
      unchanged: o('O2', 'volumeUnchanged') ?? null,
    },
    'queue.clear': r('C2.1'),
    'queue.append.nativePath': nativeWorks,
    'queue.append.fileUri': fileFormWorks,
    'queue.select': {
      result: r('C2.4'),
      base: o('C2.4', 'selectTrackBase') ?? null,
      statusTrackEqualsEngineIndex: o('C2.4', 'statusTrackEqualsEngineIndex') ?? null,
    },
    'queue.remove': { result: r('C2.5'), removedIntended: o('C2.5', 'removedIntended') ?? null },
    'playlistAdd.clear1queued0': {
      cleared: o('C2.6', 'cleared') ?? null,
      startedPlaying: o('C2.6', 'startedPlaying') ?? null,
    },
    'format.dsd': r('C3.1'),
    gapless: { result: r('C3.2'), listener: by('C3.2')?.answers.transition ?? null },
    restore: { needed: report.restore.needed, verified: report.restore.verified },
  };
}
