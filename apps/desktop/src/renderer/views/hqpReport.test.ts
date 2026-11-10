import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '@hqps/ui';
import type { HqpRunReport } from '../shell';
import { describeReport, describeSearchStep } from './hqpReport';

const zh = (key: MessageKey, params?: Record<string, string | number>) =>
  translate('zh-CN', key, params);
const en = (key: MessageKey, params?: Record<string, string | number>) =>
  translate('en', key, params);

const base: HqpRunReport = {
  id: 1,
  at: 0,
  trigger: 'startup',
  launchRequested: true,
  windowMode: 'hidden',
  exe: {
    status: 'found',
    source: 'registry',
    path: 'C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe',
    searched: [{ where: 'registry', result: 'found', detail: 'HQPlayer 6 Desktop' }],
  },
  process: { status: 'started', image: 'HQPlayer6Desktop.exe', method: 'direct', seen: true },
  window: {
    status: 'done',
    changed: 2,
    windows: [
      { title: 'HQPlayer', className: 'Qt6QWindowIcon' },
      { title: 'HQPlayer 6 Desktop', className: 'Qt6QWindowIcon' },
    ],
  },
};
const texts = (report: HqpRunReport, t = zh) => describeReport(report, t).map((l) => l.text);

describe('outcome of "start HQPlayer / hide its window" as shown in Settings', () => {
  it('describes a successful start', () => {
    expect(texts(base)).toEqual([
      '程序：HQPlayer6Desktop.exe（来源：Windows 已安装程序列表）',
      '进程：已启动 HQPlayer',
      '窗口：已隐藏 2 个窗口（HQPlayer、HQPlayer 6 Desktop）',
    ]);
    expect(describeReport(base, zh).every((l) => l.tone === 'ok')).toBe(true);
  });

  it('says "not found" and where it looked', () => {
    const lines = describeReport(
      {
        ...base,
        exe: {
          status: 'not-found',
          source: null,
          path: null,
          searched: [
            { where: 'registry', result: 'missing', detail: 'HQPlayer 6 Desktop' },
            { where: 'shortcut', result: 'none' },
            { where: 'folder', result: 'missing', detail: '2' },
            { where: 'running', result: 'none' },
          ],
        },
        process: { status: 'no-exe', image: null },
        window: { status: 'skipped', changed: 0, windows: [] },
      },
      zh,
    );
    expect(lines.map((l) => l.text)).toEqual([
      '程序：未找到。Windows 已安装程序列表：有记录，但没找到程序文件（HQPlayer 6 Desktop）；' +
        '开始菜单 / 桌面快捷方式：没有；Program Files 文件夹：有记录，但没找到程序文件；正在运行的 HQPlayer：没有',
      '进程：没有启动——找不到 HQPlayer 程序',
    ]);
    expect(lines.every((l) => l.tone === 'warn')).toBe(true);
  });

  it('shows the spawn error', () => {
    const lines = describeReport(
      {
        ...base,
        process: {
          status: 'start-failed',
          image: 'HQPlayer6Desktop.exe',
          method: 'shell',
          error: 'spawn EACCES; Access is denied.',
        },
        window: { status: 'skipped', changed: 0, windows: [] },
      },
      zh,
    );
    expect(lines[1]).toEqual({
      tone: 'warn',
      text: '进程：启动失败：spawn EACCES; Access is denied.',
    });
    expect(lines).toHaveLength(2);
  });

  it('shows a failed window step without hiding that the start worked', () => {
    const failed: HqpRunReport = {
      ...base,
      window: {
        status: 'failed',
        changed: 0,
        windows: [],
        error: 'Window control (hide) failed: [ConstrainedLanguage] Cannot add type.',
      },
    };
    expect(texts(failed).slice(1)).toEqual([
      '进程：已启动 HQPlayer',
      '窗口：隐藏失败：Window control (hide) failed: [ConstrainedLanguage] Cannot add type.',
    ]);
    expect(describeReport(failed, zh)[2]?.tone).toBe('warn');
    expect(texts(failed, en)[2]).toBe(
      'Window: failed (hide): Window control (hide) failed: [ConstrainedLanguage] Cannot add type.',
    );
  });

  it('covers the other outcomes', () => {
    expect(
      texts({
        ...base,
        process: { status: 'not-running', image: 'HQPlayer6Desktop.exe' },
        window: { status: 'skipped', changed: 0, windows: [] },
      })[1],
    ).toContain('没有开启');
    expect(
      texts({
        ...base,
        process: { status: 'started', image: 'x.exe', method: 'shell', error: 'spawn EACCES' },
      })[1],
    ).toBe('进程：已交给 Windows 启动 HQPlayer（直接启动失败：spawn EACCES）');
    expect(
      texts({ ...base, process: { ...base.process, seen: false } }).some((l) =>
        l.includes('5 秒后'),
      ),
    ).toBe(true);
    expect(
      texts({
        ...base,
        windowMode: 'minimized',
        window: { status: 'watching', changed: 0, windows: [] },
      })[2],
    ).toContain('最小化');
    expect(
      texts({ ...base, window: { status: 'no-window', changed: 0, windows: [], ms: 90_400 } })[2],
    ).toBe('窗口：HQPlayer 在 90 秒内没有显示任何窗口');
    expect(describeSearchStep({ where: 'preference', result: 'missing' }, en)).toBe(
      'the location you chose: listed, but the program file was not found',
    );
  });
});
