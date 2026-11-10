import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import {
  EngineCommandError,
  EngineTimeoutError,
  EngineUnavailableError,
} from '@hqps/hqplayer-adapter';
import type { GateIO, StepRecord } from '../gatec/run';
import { GateGuardError } from '../gatec/session';
import {
  compareLists,
  describeItem,
  describeRate,
  diffState,
  DSP_KINDS,
  inferStateRef,
  itemFor,
  pickLowerRate,
  pickTarget,
  stateNumberOf,
  summarizeTimeline,
  type Form,
  type RestoreKey,
  type StateRef,
} from './logic';
import {
  DspGateSession,
  SET_COMMAND,
  type DspItem,
  type DspKind,
  type DspLists,
  type DspLiveStatus,
  type DspStateSnapshot,
} from './session';

export const DSPGATE_VERSION = '0.1.0';
export const DSPGATE_SCHEMA = 'hqps.dspgate.v1';

export interface SelectAttempt {
  form: Form;
  value: number;
  value1x?: number;
  accepted: boolean;
  error?: string;
  /** State showed the intended item afterwards. */
  matched: boolean;
  ms: number;
  state: Record<string, string>;
}

export interface SelectOutcome {
  ok: boolean;
  form: Form | null;
  /** index == value for the items used, so the two readings could not be told apart. */
  ambiguous: boolean;
  attempts: SelectAttempt[];
}

export interface DspGateReport {
  schema: typeof DSPGATE_SCHEMA;
  toolVersion: string;
  generatedAt: string;
  sanitized: true;
  environment: { platform: string; release: string; arch: string };
  engine: Record<string, string | null> | null;
  reachable: boolean;
  aborted: boolean;
  start: {
    state: Record<string, string>;
    status: {
      transport: string;
      activeMode: string | null;
      activeFilter: string | null;
      activeShaper: string | null;
      activeRate: number | null;
    } | null;
    stateRef: Record<DspKind, StateRef>;
    current: Record<DspKind, DspItem | null>;
    filter1x: DspItem | null;
    filterNx: DspItem | null;
    lists: DspLists;
    matrix: { profiles: number; currentSet: boolean; currentListed: boolean };
    playlistLength: number;
    stoppedByTool: boolean;
  } | null;
  steps: StepRecord[];
  restore: {
    needed: boolean;
    performed: boolean;
    verified: boolean | null;
    differencesBefore: RestoreKey[];
    differencesAfter: RestoreKey[];
    notes: string[];
  };
  findings: Record<string, unknown>;
}

export interface DspGateOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  timeScale?: number;
  outDir: string;
  io: GateIO;
  stamp: string;
}

const TOGGLES = [
  { id: 'D6.1', key: 'invert', cmd: 'SetInvert', title: 'Invert / 反相' },
  { id: 'D6.2', key: 'convolution', cmd: 'SetConvolution', title: 'Convolution / 卷积' },
  { id: 'D6.3', key: 'adaptive', cmd: 'SetAdaptiveVolume', title: 'Adaptive volume / 自适应音量' },
] as const;

const yn = { y: '是 / yes', n: '否 / no' };

export async function runDspGate(o: DspGateOptions): Promise<{
  report: DspGateReport;
  originalFile: string | null;
  exitCode: number;
}> {
  const { io } = o;
  const sessionOptions = {
    host: o.host ?? '127.0.0.1',
    port: o.port ?? 4321,
    timeoutMs: o.timeoutMs,
    timeScale: o.timeScale,
  };
  let s = new DspGateSession(sessionOptions);
  const report: DspGateReport = {
    schema: DSPGATE_SCHEMA,
    toolVersion: DSPGATE_VERSION,
    generatedAt: new Date().toISOString(),
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
      differencesBefore: [],
      differencesAfter: [],
      notes: [],
    },
    findings: {},
  };

  try {
    await s.open();
  } catch (err) {
    io.print(`✘ 无法连接 HQPlayer / cannot connect: ${(err as Error).message}`);
    io.print('  请先打开 HQPlayer Desktop。/ Start HQPlayer Desktop first.');
    return { report, originalFile: null, exitCode: 3 };
  }
  report.reachable = true;

  // ---------------------------------------------------------------- D0: read-only snapshot
  const info = await s.send('GetInfo');
  report.engine = {
    product: info.attributes.product ?? null,
    version: info.attributes.version ?? null,
    engine: info.attributes.engine ?? null,
    platform: info.attributes.platform ?? null,
  };
  let snap = await s.state();
  const lists = await s.readLists();
  const matrix = await s.matrix();
  const playlistLength = await s.playlistLength();
  const status0 = s.status();

  const stateRef: Record<DspKind, StateRef> = {
    mode: inferStateRef(lists.mode, snap.mode, status0?.activeMode ?? null),
    filter: inferStateRef(lists.filter, snap.filter, status0?.activeFilter ?? null),
    shaper: inferStateRef(lists.shaper, snap.shaper, status0?.activeShaper ?? null),
    rate: inferStateRef(
      lists.rate,
      snap.rate,
      status0?.activeRate ? String(status0.activeRate) : null,
    ),
  };
  const num = (kind: DspKind, item: DspItem) => stateNumberOf(item, stateRef[kind].form);
  const original: Record<DspKind, DspItem | null> = {
    mode: itemFor(lists.mode, stateRef.mode.form, snap.mode),
    filter: itemFor(lists.filter, stateRef.filter.form, snap.filter),
    shaper: itemFor(lists.shaper, stateRef.shaper.form, snap.shaper),
    rate: itemFor(lists.rate, stateRef.rate.form, snap.rate),
  };
  const original1x = itemFor(lists.filter, stateRef.filter.form, snap.filter1x);
  const originalNx = itemFor(lists.filter, stateRef.filter.form, snap.filterNx);

  const originalText = [
    `HQPlayer DSP settings before the test / 测试前的 HQPlayer DSP 设置`,
    `hqp-dspgate ${DSPGATE_VERSION} — ${new Date().toISOString()}`,
    '',
    `Mode / 模式:               ${describeItem(original.mode)}`,
    `Filter / 滤波器:           ${describeItem(original.filter)}`,
    `  1x filter:               ${describeItem(original1x)}`,
    `  Nx filter:               ${describeItem(originalNx)}`,
    `Shaper / modulator:        ${describeItem(original.shaper)}`,
    `Rate / 输出采样率:         ${describeRate(original.rate)}`,
    `Invert / 反相:             ${snap.invert ?? '?'}`,
    `Convolution / 卷积:        ${snap.convolution ?? '?'}`,
    `Adaptive volume:           ${snap.adaptive ?? '?'}`,
    `Matrix profile:            ${snap.matrixProfile || '(none)'}`,
    '',
    'If the tool could not restore these, set them again in HQPlayer’s main window.',
    '如果工具没能恢复这些设置，请在 HQPlayer 主窗口里手动改回。',
    '',
  ].join('\n');
  const originalFile = join(o.outDir, `hqp-dspgate-original-${o.stamp}.txt`);
  writeFileSync(originalFile, originalText, 'utf8');

  io.print(
    `\n✔ 已连接 ${report.engine.product ?? 'HQPlayer'} (engine ${report.engine.engine ?? '?'})`,
  );
  io.print('✔ 已记录当前 DSP 设置 / current DSP settings saved to:');
  io.print(`    ${originalFile}`);
  for (const line of originalText.split('\n').slice(3, 13)) io.print(`    ${line}`);

  let stoppedByTool = false;
  const fillStart = () => {
    report.start = {
      state: { ...snap.raw },
      status: status0 && {
        transport: status0.transport,
        activeMode: status0.activeMode,
        activeFilter: status0.activeFilter,
        activeShaper: status0.activeShaper,
        activeRate: status0.activeRate,
      },
      stateRef,
      current: original,
      filter1x: original1x,
      filterNx: originalNx,
      lists,
      matrix: {
        profiles: matrix.profiles.length,
        currentSet: !!matrix.current,
        currentListed: !!matrix.current && matrix.profiles.includes(matrix.current),
      },
      playlistLength,
      stoppedByTool,
    };
  };
  fillStart();

  const finish = (exitCode: number) => {
    s.close();
    return { report, originalFile, exitCode };
  };

  if (snap.transport !== 'stopped') {
    const a = await io.ask(
      'HQPlayer 正在播放或暂停。测试必须从停止状态开始，结束后不会自动恢复播放。现在停止？\n' +
        '  HQPlayer is playing or paused. The test starts from stopped and will not resume playback. Stop now?',
      { y: '停止并继续 / stop and continue', n: '退出 / exit' },
    );
    if (a !== 'y') {
      report.aborted = true;
      io.print('已退出，没有发送任何写命令。/ Exited without sending any write command.');
      return finish(0);
    }
    await s.send('Stop');
    const stopped = await s.pollState((x) => x.transport === 'stopped', 15000);
    if (!stopped.matched) {
      report.aborted = true;
      io.print('✘ HQPlayer 没有停止，测试取消。/ HQPlayer did not stop; test cancelled.');
      return finish(0);
    }
    stoppedByTool = true;
    snap = { ...snap, transport: 'stopped' };
    fillStart();
  }

  io.print('\n本测试会临时更改 模式 / 滤波器 / 调制器 / 采样率 / 开关，每一步改完立即改回。');
  io.print(
    'This test briefly changes mode / filter / shaper / rate / toggles and reverts each one.',
  );
  io.print('只发送 HQPlayer 自己列出的选项；采样率只会调低；不会调音量。');
  io.print(
    'Only options HQPlayer itself lists are sent; the rate is only lowered; volume is untouched.',
  );
  const startAnswer = await io.ask('开始 DSP 测试？/ Start the DSP test now?', {
    y: '开始 / start',
    n: '退出 / exit',
  });
  if (startAnswer !== 'y') {
    report.aborted = true;
    io.print('已退出，没有更改任何 DSP 设置。/ Exited without changing any DSP setting.');
    return finish(0);
  }

  // ---------------------------------------------------------------- shared helpers
  let aborted = false;
  let wrote = false;
  let startedPlayback = false;
  const setForm: Record<DspKind, Form | null> = {
    mode: null,
    filter: null,
    shaper: null,
    rate: null,
  };
  const ambiguousKinds = new Set<DspKind>();

  const check = (rec: StepRecord, ok: boolean, note: string) => {
    if (!ok) {
      rec.result = 'fail';
      rec.notes.push(note);
    }
  };

  /**
   * Select `target` and confirm it with State. When it is not yet known whether the command
   * takes the list index or the list value, the index is tried first and the value second;
   * whichever makes State show the target is remembered for that selector.
   */
  const select = async (
    kind: DspKind,
    target: DspItem,
    match: (st: DspStateSnapshot) => boolean,
    oneX?: DspItem,
  ): Promise<SelectOutcome> => {
    const sameNumbers =
      (target.value === null || target.value === target.index) &&
      (!oneX || oneX.value === null || oneX.value === oneX.index);
    const known = setForm[kind];
    const forms: Form[] = known ? [known] : sameNumbers ? ['index'] : ['index', 'value'];
    const out: SelectOutcome = { ok: false, form: null, ambiguous: sameNumbers, attempts: [] };
    for (const form of forms) {
      const value = form === 'index' ? target.index : target.value;
      const value1x = oneX ? (form === 'index' ? oneX.index : oneX.value) : undefined;
      if (value === null || value1x === null) continue;
      const attrs: Record<string, number> = { value };
      if (value1x !== undefined) attrs.value1x = value1x;
      const attempt: SelectAttempt = {
        form,
        value,
        accepted: false,
        matched: false,
        ms: 0,
        state: {},
      };
      if (value1x !== undefined) attempt.value1x = value1x;
      out.attempts.push(attempt);
      let timedOut = false;
      wrote = true;
      try {
        await s.send(SET_COMMAND[kind], attrs);
        attempt.accepted = true;
      } catch (err) {
        if (err instanceof EngineCommandError) {
          attempt.error = s.redactor.apply(err.message).slice(0, 200);
        } else if (err instanceof EngineTimeoutError) {
          attempt.error = 'no answer in time';
          timedOut = true;
        } else throw err;
      }
      const polled = await s.pollState(match, attempt.accepted ? 3000 : timedOut ? 10000 : 500);
      attempt.matched = polled.matched;
      attempt.ms = polled.ms;
      attempt.state = { ...polled.state.raw };
      if (polled.matched) {
        out.ok = true;
        out.form = form;
        if (!sameNumbers) setForm[kind] = form;
        else if (!known) ambiguousKinds.add(kind);
        return out;
      }
      if (timedOut) break; // engine busy: do not send a second form on top
    }
    return out;
  };

  const selectSimple = (kind: DspKind, item: DspItem) =>
    select(kind, item, (st) => st[kind] === num(kind, item));

  /** Put the filter(s) back exactly as they were at the start. */
  const restoreFilter = async (): Promise<boolean> => {
    if (original1x && originalNx) {
      const r = await select(
        'filter',
        originalNx,
        (st) =>
          st.filterNx === num('filter', originalNx) && st.filter1x === num('filter', original1x),
        original1x,
      );
      if (r.ok) return true;
      if (original1x.index !== originalNx.index) return false;
    }
    if (!original.filter) return false;
    return (await selectSimple('filter', original.filter)).ok;
  };

  /** After a step reverted its own change: anything still different stops the test. */
  const assertReverted = async (rec: StepRecord): Promise<void> => {
    const now = await s.state();
    const left = diffState(snap, now);
    rec.observations.stateAfterRevert = { ...now.raw };
    if (left.length) {
      check(rec, false, `not reverted: ${left.join(', ')}`);
      aborted = true;
      io.print(
        '✘ 这一步没有完全改回，停止后续步骤并尝试恢复。/ Not fully reverted; stopping and restoring.',
      );
    }
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
      report.aborted = true;
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
      aborted = true;
      if (err instanceof EngineUnavailableError || !s.connected)
        io.print('✘ 与 HQPlayer 的连接断开，尝试恢复。/ Connection lost; trying to restore.');
    } finally {
      s.capture(null);
      s.watchStatus(null);
    }
    io.print(
      `  → ${rec.result.toUpperCase()}${rec.notes.length ? ` (${rec.notes.join('; ')})` : ''}`,
    );
    return rec;
  };

  /** Let the listener override the automatically chosen target with another list entry. */
  const chooseTarget = async (
    kind: 'filter' | 'shaper',
    list: DspItem[],
    current: DspItem,
    proposed: DspItem,
  ): Promise<DspItem> => {
    io.print(`\n${kind === 'filter' ? '滤波器 / filters' : '调制器 / shapers'}:`);
    for (let i = 0; i < list.length; i += 3)
      io.print(
        `  ${list
          .slice(i, i + 3)
          .map((x) => describeItem(x).padEnd(34))
          .join('')}`,
      );
    for (let tries = 0; tries < 3; tries++) {
      const a = (
        await io.text(
          `测试用的${kind === 'filter' ? '滤波器' : '调制器'}（当前 ${describeItem(current)}）：回车 = ${describeItem(proposed)}，或输入上面列表里的序号。\n` +
            `请选一个你的电脑能流畅播放的。/ Test ${kind} (current ${describeItem(current)}): Enter = ${describeItem(proposed)}, or type a number from the list. Pick one your PC plays smoothly.`,
        )
      ).trim();
      if (a === '') return proposed;
      const hit = /^\d+$/.test(a) ? list.find((x) => x.index === Number(a)) : undefined;
      if (hit && hit.index !== current.index) return hit;
      io.print('    不在列表中或与当前相同 / not in the list, or same as the current one');
    }
    return proposed;
  };

  // ---------------------------------------------------------------- targets
  const shaperProposed = original.shaper ? pickTarget(lists.shaper, original.shaper) : null;
  const shaperTarget =
    original.shaper && shaperProposed
      ? await chooseTarget('shaper', lists.shaper, original.shaper, shaperProposed)
      : null;
  const filterBase = originalNx ?? original.filter;
  const filterProposed = filterBase
    ? pickTarget(lists.filter, filterBase, (i) => i.index !== original1x?.index)
    : null;
  const filterTarget =
    filterBase && filterProposed
      ? await chooseTarget('filter', lists.filter, filterBase, filterProposed)
      : null;
  const rateTarget = original.rate
    ? pickLowerRate(lists.rate, original.rate, status0?.activeRate ?? null)
    : null;
  const isSdm = (i: DspItem) => /sdm|dsd/i.test(i.name);
  const modeTarget = original.mode
    ? pickTarget(lists.mode, original.mode, (i) =>
        isSdm(original.mode as DspItem) ? /pcm/i.test(i.name) : isSdm(i),
      )
    : null;
  const unknown = (what: string) =>
    `无法在列表中确定当前${what}，不更改 / cannot identify the current ${what}; left untouched`;

  // ---------------------------------------------------------------- D1: shaper
  await step(
    'D1',
    'SetShaping',
    `调制器改为 ${describeItem(shaperTarget)} 再改回 / change shaper, then revert`,
    async (rec) => {
      const target = shaperTarget as DspItem;
      rec.observations.target = target;
      const r = await selectSimple('shaper', target);
      rec.observations.change = r;
      check(rec, r.ok, 'State did not show the new shaper');
      const back = await selectSimple('shaper', original.shaper as DspItem);
      rec.observations.revert = back;
      await assertReverted(rec);
    },
    !original.shaper ? unknown('调制器 / shaper') : !shaperTarget ? 'no other shaper' : null,
  );

  // ---------------------------------------------------------------- D2: filter, Nx + 1x
  let twoArgWorks: boolean | null = null;
  await step(
    'D2',
    'SetFilter value + value1x',
    `Nx 滤波器改为 ${describeItem(filterTarget)}，1x 保持不变，再改回 / change the Nx filter only, then revert`,
    async (rec) => {
      const target = filterTarget as DspItem;
      const oneX = original1x as DspItem;
      rec.observations.target = target;
      const r = await select(
        'filter',
        target,
        (st) => st.filterNx === num('filter', target) && st.filter1x === num('filter', oneX),
        oneX,
      );
      rec.observations.change = r;
      twoArgWorks = r.ok;
      check(rec, r.ok, 'State did not show the new Nx filter with the 1x filter unchanged');
      rec.observations.revertOk = await restoreFilter();
      await assertReverted(rec);
    },
    !filterTarget
      ? unknown('滤波器 / filter')
      : !original1x || !originalNx
        ? 'State 没有 filter1x / filterNx / State has no filter1x / filterNx'
        : null,
  );

  // ---------------------------------------------------------------- D3: filter, single value
  const splitFilters = !!original1x && !!originalNx && original1x.index !== originalNx.index;
  await step(
    'D3',
    'SetFilter value',
    `只发一个滤波器值 ${describeItem(filterTarget)}，看 1x 和 Nx 是否一起变 / one value: does it set both 1x and Nx?`,
    async (rec) => {
      const target = filterTarget as DspItem;
      const n = num('filter', target);
      rec.observations.target = target;
      const r = await select(
        'filter',
        target,
        (st) => st.filter === n || st.filterNx === n || st.filter1x === n,
      );
      rec.observations.change = r;
      check(rec, r.ok, 'State did not show the new filter');
      const after = await s.state();
      rec.observations.setsFilter = after.filter === n;
      rec.observations.sets1x = after.filter1x === null ? null : after.filter1x === n;
      rec.observations.setsNx = after.filterNx === null ? null : after.filterNx === n;
      rec.observations.revertOk = await restoreFilter();
      await assertReverted(rec);
    },
    !filterTarget
      ? unknown('滤波器 / filter')
      : splitFilters && twoArgWorks !== true
        ? '1x 与 Nx 不同且双参数形式未验证，无法保证改回 / 1x and Nx differ and the two-value form is unverified'
        : null,
  );

  // ---------------------------------------------------------------- D4: rate (lower only)
  await step(
    'D4',
    'SetRate',
    `输出采样率调低为 ${describeRate(rateTarget)} 再改回（停止状态，不出声）/ lower the rate, then revert`,
    async (rec) => {
      const target = rateTarget as DspItem;
      rec.observations.target = target;
      const r = await selectSimple('rate', target);
      rec.observations.change = r;
      check(rec, r.ok, 'State did not show the new rate');
      rec.observations.revert = await selectSimple('rate', original.rate as DspItem);
      await assertReverted(rec);
    },
    !original.rate
      ? unknown('采样率 / rate')
      : !rateTarget
        ? '没有同系列的更低采样率 / no lower rate in the same family'
        : null,
  );

  // ---------------------------------------------------------------- D5: mode + dependent lists
  await step(
    'D5',
    'SetMode',
    `模式改为 ${describeItem(modeTarget)}，重读列表，再改回（停止状态）/ change mode, re-read lists, revert`,
    async (rec) => {
      const target = modeTarget as DspItem;
      rec.observations.target = target;
      const r = await selectSimple('mode', target);
      rec.observations.change = r;
      check(rec, r.ok, 'State did not show the new mode');
      const during = await s.readLists();
      const same = compareLists(lists, during);
      rec.observations.listsSameInOtherMode = same;
      rec.observations.listSizesInOtherMode = Object.fromEntries(
        DSP_KINDS.map((k) => [k, during[k].length]),
      );
      rec.observations.otherModeLists = {
        shaper: during.shaper,
        rate: during.rate,
        filter: same.filter ? 'same' : during.filter.map((f) => ({ ...f, description: undefined })),
      };
      const st = await s.state();
      rec.observations.stateInOtherMode = { ...st.raw };
      rec.observations.revert = await selectSimple('mode', original.mode as DspItem);
      const afterLists = await s.readLists();
      rec.observations.listsRestored = compareLists(lists, afterLists);
      const back = await s.state();
      rec.observations.selectionsKeptAfterRoundTrip =
        back.shaper === snap.shaper && back.rate === snap.rate && back.filter === snap.filter;
      // Selections may be remembered per mode; put them back before the strict check.
      if (back.mode === snap.mode) {
        if (
          (back.filter !== snap.filter ||
            back.filter1x !== snap.filter1x ||
            back.filterNx !== snap.filterNx) &&
          original.filter
        )
          await restoreFilter();
        if (back.shaper !== snap.shaper && original.shaper)
          await selectSimple('shaper', original.shaper);
        if (back.rate !== snap.rate && original.rate) await selectSimple('rate', original.rate);
      }
      await assertReverted(rec);
    },
    !original.mode ? unknown('模式 / mode') : !modeTarget ? 'no other mode' : null,
  );

  // ---------------------------------------------------------------- D6: toggles
  for (const t of TOGGLES) {
    const before = snap[t.key];
    await step(
      t.id,
      t.cmd,
      `${t.title}: ${before} → ${before === 1 ? 0 : 1} → ${before}`,
      async (rec) => {
        const flipped = before === 1 ? 0 : 1;
        wrote = true;
        try {
          await s.send(t.cmd, { value: flipped });
          rec.observations.accepted = true;
        } catch (err) {
          if (!(err instanceof EngineCommandError)) throw err;
          rec.observations.accepted = false;
          rec.result = 'info';
          rec.notes.push(s.redactor.apply(err.message).slice(0, 200));
        }
        const on = await s.pollState((st) => st[t.key] === flipped, 3000);
        rec.observations.changed = on.matched;
        if (rec.observations.accepted) check(rec, on.matched, `State ${t.key} did not change`);
        if (on.state[t.key] !== before) {
          await s.send(t.cmd, { value: before as number });
          await s.pollState((st) => st[t.key] === before, 3000);
        }
        await assertReverted(rec);
      },
      before !== 0 && before !== 1 ? `State 没有 ${t.key} / State has no ${t.key} attribute` : null,
    );
  }

  // ---------------------------------------------------------------- D7: matrix profile
  const matrixOther = matrix.profiles.find((p) => p !== matrix.current) ?? null;
  await step(
    'D7',
    'MatrixSetProfile',
    '切换到另一个矩阵配置再切回 / switch to another matrix profile and back',
    async (rec) => {
      wrote = true;
      await s.send('MatrixSetProfile', { value: matrixOther as string });
      await s.sleep(1000);
      const now = await s.matrix();
      rec.observations.changed = now.current === matrixOther;
      check(rec, now.current === matrixOther, 'MatrixGetProfile did not show the new profile');
      await s.send('MatrixSetProfile', { value: matrix.current as string });
      await s.sleep(1000);
      const back = await s.matrix();
      check(rec, back.current === matrix.current, 'matrix profile was not restored');
      if (back.current !== matrix.current) aborted = true;
      await assertReverted(rec);
    },
    !matrix.profiles.length
      ? 'HQPlayer 没有矩阵配置 / no matrix profiles defined'
      : !matrix.current || !matrix.profiles.includes(matrix.current)
        ? '当前没有选中配置，无法保证改回 / no profile selected now, so it could not be restored'
        : !matrixOther
          ? '只有一个配置 / only one profile'
          : null,
  );

  // ---------------------------------------------------------------- D8: change while playing
  const whilePlaying = async (
    rec: StepRecord,
    kind: 'shaper' | 'filter',
    target: DspItem,
  ): Promise<void> => {
    const key = kind === 'shaper' ? 'activeShaper' : 'activeFilter';
    startedPlayback = true;
    await s.send('Play', { last: 0 });
    const playing = await s.waitForStatus((x) => x.transport === 'playing', 10000);
    check(rec, playing !== null, 'state did not become playing');
    try {
      if (!playing) return;
      await s.sleep(5000);
      const heard = await io.ask('听到声音了吗？/ Do you hear music?', yn);
      rec.answers.heardBefore = heard;
      if (heard === 'n') {
        check(rec, false, 'listener heard nothing before the change');
        return;
      }
      const change = async (label: 'change' | 'revert', run: () => Promise<unknown>) => {
        const sink: DspLiveStatus[] = [];
        const before = s.status();
        s.watchStatus(sink);
        const sentAt = Date.now();
        rec.observations[label] = await run();
        await s.sleep(8000);
        s.watchStatus(null);
        rec.observations[`${label}Timeline`] = summarizeTimeline(sink, sentAt, key, before);
      };
      await change('change', () =>
        kind === 'shaper'
          ? selectSimple('shaper', target)
          : original1x && originalNx && twoArgWorks
            ? select('filter', target, (st) => st.filterNx === num('filter', target), original1x)
            : selectSimple('filter', target),
      );
      rec.answers.heard = await io.ask('更改时听到了什么？/ What did you hear when it changed?', {
        c: '没有中断 / no interruption',
        g: '短暂中断后继续 / short gap, then continued',
        r: '从头重新播放 / track restarted',
        s: '停止或一直无声 / stopped or stayed silent',
      });
      await change('revert', () =>
        kind === 'shaper' ? selectSimple('shaper', original.shaper as DspItem) : restoreFilter(),
      );
    } finally {
      await s.send('Stop');
      const stopped = await s.pollState((x) => x.transport === 'stopped', 15000);
      check(rec, stopped.matched, 'HQPlayer did not stop');
    }
    await assertReverted(rec);
  };

  const noPlay = playlistLength === 0 ? 'HQPlayer 播放列表为空 / playlist empty' : null;
  await step(
    'D8.1',
    'SetShaping while playing',
    `播放当前播放列表，播放中把调制器改为 ${describeItem(shaperTarget)} 再改回，然后停止 / change the shaper during playback`,
    (rec) => whilePlaying(rec, 'shaper', shaperTarget as DspItem),
    noPlay ?? (!original.shaper || !shaperTarget ? unknown('调制器 / shaper') : null),
  );
  await step(
    'D8.2',
    'SetFilter while playing',
    `播放中把滤波器改为 ${describeItem(filterTarget)} 再改回，然后停止 / change the filter during playback`,
    (rec) => whilePlaying(rec, 'filter', filterTarget as DspItem),
    noPlay ??
      (!filterTarget
        ? unknown('滤波器 / filter')
        : splitFilters && twoArgWorks !== true
          ? '双参数形式未验证，无法保证改回 / two-value form unverified'
          : null),
  );

  // ---------------------------------------------------------------- D9: restore + verify
  report.aborted = report.aborted || aborted;
  report.restore.needed = wrote;
  const restoreRec: StepRecord = {
    id: 'D9',
    title: 'Restore',
    result: 'pass',
    commands: [],
    observations: {},
    answers: {},
    notes: [],
  };
  report.steps.push(restoreRec);
  if (!wrote) {
    restoreRec.result = 'skipped';
    restoreRec.notes.push('nothing was changed');
    report.restore.verified = true;
  } else {
    io.print('\n[D9] 核对并恢复原设置 / verifying and restoring the original settings…');
    try {
      if (!s.connected) {
        s = new DspGateSession(sessionOptions);
        await s.open();
        await s.readLists();
        await s.matrix();
        report.restore.notes.push('reconnected for restore');
      }
      s.capture(restoreRec.commands);
      let now = await s.state();
      if (startedPlayback && now.transport !== 'stopped') {
        await s.send('Stop');
        now = (await s.pollState((x) => x.transport === 'stopped', 15000)).state;
      }
      let left = diffState(snap, now);
      report.restore.differencesBefore = left;
      const attempt = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (err) {
          if (err instanceof GateGuardError) throw err;
          report.restore.notes.push(
            s.redactor.apply(`${what}: ${(err as Error).message}`).slice(0, 200),
          );
        }
      };
      if (left.length) {
        report.restore.performed = true;
        if (left.includes('mode') && original.mode)
          await attempt('mode', () => selectSimple('mode', original.mode as DspItem));
        await s.readLists();
        left = diffState(snap, await s.state());
        if (left.some((k) => k === 'filter' || k === 'filter1x' || k === 'filterNx'))
          await attempt('filter', restoreFilter);
        if (left.includes('shaper') && original.shaper)
          await attempt('shaper', () => selectSimple('shaper', original.shaper as DspItem));
        if (left.includes('rate') && original.rate)
          await attempt('rate', () => selectSimple('rate', original.rate as DspItem));
        for (const t of TOGGLES) {
          const v = snap[t.key];
          if (left.includes(t.key) && (v === 0 || v === 1))
            await attempt(t.key, () => s.send(t.cmd, { value: v }));
        }
        if (
          left.includes('matrixProfile') &&
          matrix.current &&
          matrix.profiles.includes(matrix.current)
        )
          await attempt('matrix', () =>
            s.send('MatrixSetProfile', { value: matrix.current as string }),
          );
        await s.sleep(1000);
        left = diffState(snap, await s.state());
      }
      report.restore.differencesAfter = left;
      report.restore.verified = left.length === 0;
    } catch (err) {
      if (err instanceof GateGuardError) throw err;
      report.restore.verified = false;
      report.restore.notes.push(s.redactor.apply((err as Error).message).slice(0, 200));
    } finally {
      s.capture(null);
    }
    if (report.restore.verified) {
      io.print('  ✔ DSP 设置与测试前完全一致 / DSP settings are exactly as before the test');
    } else {
      restoreRec.result = 'fail';
      restoreRec.notes.push(
        `still different: ${report.restore.differencesAfter.join(', ') || 'unknown (no connection)'}`,
      );
      io.print('\n⚠ 没有完全恢复。请在 HQPlayer 主窗口里手动改回下面的设置：');
      io.print('  Not fully restored. Please set these again in HQPlayer’s main window:');
      for (const line of originalText.split('\n').slice(3, 13)) io.print(`    ${line}`);
      io.print(`  （同样的内容保存在 / also saved in ${originalFile}）`);
    }
  }

  report.findings = buildFindings(report, setForm, ambiguousKinds, stateRef);
  return finish(0);
}

function buildFindings(
  report: DspGateReport,
  setForm: Record<DspKind, Form | null>,
  ambiguous: Set<DspKind>,
  stateRef: Record<DspKind, StateRef>,
): Record<string, unknown> {
  const by = (id: string) => report.steps.find((x) => x.id === id);
  const r = (id: string) => by(id)?.result ?? 'not-run';
  const o = (id: string, key: string) => by(id)?.observations[key] ?? null;
  const takes = (k: DspKind) => setForm[k] ?? (ambiguous.has(k) ? 'ambiguous' : 'unknown');
  const playing = (id: string) => ({
    result: r(id),
    listener: by(id)?.answers.heard ?? null,
    timeline: o(id, 'changeTimeline'),
  });
  return {
    /** Does Set* take the list index or the list value? */
    setTakes: Object.fromEntries(DSP_KINDS.map((k) => [k, takes(k)])),
    stateReports: stateRef,
    'shaper.set': r('D1'),
    'filter.setNxAnd1x': r('D2'),
    'filter.setSingle': {
      result: r('D3'),
      sets1x: o('D3', 'sets1x'),
      setsNx: o('D3', 'setsNx'),
    },
    'rate.set': r('D4'),
    'mode.set': {
      result: r('D5'),
      listsSameInOtherMode: o('D5', 'listsSameInOtherMode'),
      selectionsKeptAfterRoundTrip: o('D5', 'selectionsKeptAfterRoundTrip'),
    },
    toggles: Object.fromEntries(TOGGLES.map((t) => [t.key, r(t.id)])),
    'matrix.set': r('D7'),
    whilePlaying: { shaper: playing('D8.1'), filter: playing('D8.2') },
    restore: { needed: report.restore.needed, verified: report.restore.verified },
    /** The tool reverts everything, so survival across an HQPlayer restart is not covered. */
    persistsAcrossRestart: 'not-tested',
  };
}
