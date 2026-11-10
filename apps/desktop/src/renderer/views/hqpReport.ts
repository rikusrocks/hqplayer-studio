/**
 * Turns the report of one "start HQPlayer / tidy its window" run into the lines shown in
 * Settings → HQPlayer 程序. Pure, so the wording of every outcome is covered by tests.
 */
import type { MessageKey } from '@hqps/ui';
import type { HqpRunReport, HqpSearchStep } from '../shell';

type T = (key: MessageKey, params?: Record<string, string | number>) => string;

export interface ReportLine {
  tone: 'ok' | 'warn' | 'info';
  text: string;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** "已安装程序列表：有记录，但没找到程序文件（HQPlayer 6 Desktop）" */
export function describeSearchStep(step: HqpSearchStep, t: T): string {
  const where = t(`hqpApp.source.${step.where}`);
  const result = t(`hqpApp.search.${step.result}`);
  // counts are only useful to the developer (they are in the copied diagnostics)
  return step.detail && !/^\d+$/.test(step.detail)
    ? t('hqpApp.searchLineDetail', { where, result, detail: step.detail })
    : t('hqpApp.searchLine', { where, result });
}

export function describeReport(report: HqpRunReport, t: T): ReportLine[] {
  const lines: ReportLine[] = [];
  const { exe, process: proc, window: win } = report;
  const action = t(report.windowMode === 'minimized' ? 'hqpApp.act.minimize' : 'hqpApp.act.hide');

  // 1. the program
  if (exe.status === 'found' && exe.path) {
    lines.push({
      tone: 'ok',
      text: t('hqpApp.r.exeFound', {
        file: fileName(exe.path),
        source: t(`hqpApp.source.${exe.source ?? 'preference'}`),
      }),
    });
  } else {
    lines.push({
      tone: proc.status === 'running' ? 'info' : 'warn',
      text: t('hqpApp.r.exeNotFound', {
        searched:
          exe.searched.map((s) => describeSearchStep(s, t)).join(t('hqpApp.sep.clause')) || '—',
      }),
    });
  }

  // 2. the process
  if (proc.checkError) {
    lines.push({ tone: 'warn', text: t('hqpApp.r.checkError', { error: proc.checkError }) });
  }
  switch (proc.status) {
    case 'running':
      lines.push({ tone: 'ok', text: t('hqpApp.r.running', { image: proc.image ?? 'HQPlayer' }) });
      break;
    case 'started':
      lines.push(
        proc.method === 'shell'
          ? { tone: 'ok', text: t('hqpApp.r.startedShell', { error: proc.error ?? '—' }) }
          : { tone: 'ok', text: t('hqpApp.r.started') },
      );
      if (proc.seen === false) lines.push({ tone: 'warn', text: t('hqpApp.r.startedNotSeen') });
      break;
    case 'not-running':
      lines.push({
        tone: 'info',
        text: t(
          report.trigger === 'startup' ? 'hqpApp.r.notRunningAutoOff' : 'hqpApp.r.notRunning',
        ),
      });
      break;
    case 'no-exe':
      lines.push({ tone: 'warn', text: t('hqpApp.r.noExe') });
      break;
    case 'start-failed':
      lines.push({ tone: 'warn', text: t('hqpApp.r.startFailed', { error: proc.error ?? '—' }) });
      break;
  }

  // 3. its windows
  const titles = win.windows.map((w) => w.title || w.className).join(t('hqpApp.sep.item'));
  switch (win.status) {
    case 'skipped':
      if (
        report.windowMode === 'normal' &&
        (proc.status === 'running' || proc.status === 'started')
      )
        lines.push({ tone: 'info', text: t('hqpApp.r.winNormal') });
      break;
    case 'watching':
      lines.push({ tone: 'info', text: t('hqpApp.r.winWatching', { action }) });
      break;
    case 'done':
      lines.push(
        win.changed > 0
          ? { tone: 'ok', text: t('hqpApp.r.winDone', { action, count: win.changed, titles }) }
          : { tone: 'ok', text: t('hqpApp.r.winNothing', { action }) },
      );
      break;
    case 'no-window':
      lines.push({
        tone: 'warn',
        text: t('hqpApp.r.winNoWindow', { seconds: Math.round((win.ms ?? 0) / 1000) }),
      });
      break;
    case 'not-running':
      lines.push({ tone: 'warn', text: t('hqpApp.r.winNotRunning') });
      break;
    case 'failed':
      lines.push({
        tone: 'warn',
        text: t('hqpApp.r.winFailed', { action, error: win.error ?? '—' }),
      });
      break;
    case 'cancelled':
      lines.push({ tone: 'info', text: t('hqpApp.r.winCancelled') });
      break;
  }
  return lines;
}
