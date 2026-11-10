/**
 * hqp-dspgate — DSP write-command test for HQPlayer Desktop.
 *
 * Finds out, on the user's own engine, how SetMode / SetFilter / SetShaping / SetRate, the DSP
 * toggles and MatrixSetProfile behave: whether they take a list index or a list value, whether
 * the lists depend on the mode, and what happens when a setting changes during playback.
 * Every change is made one step at a time (Enter each), confirmed with State, and reverted
 * straight away; the settings are compared with the starting snapshot at the end.
 *
 * It is a separate tool from hqp-gatec on purpose: Gate C never sends DSP commands, and this
 * tool never edits the playlist, the volume, the output device or the configuration.
 *
 * Options: --host 127.0.0.1  --port 4321  --timeout 15000  --out <dir>  --no-pause
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { consoleIO } from './gatec/console-io';
import { DSPGATE_VERSION, runDspGate } from './dspgate/run';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function isSea(): Promise<boolean> {
  try {
    const sea = await import('node:sea');
    return sea.isSea();
  } catch {
    return false;
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writableDir(preferred: string): string {
  for (const dir of [preferred, join(os.homedir(), 'Desktop'), os.tmpdir()]) {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.hqps-write-test-${process.pid}`);
      writeFileSync(probe, '');
      unlinkSync(probe);
      return dir;
    } catch {
      // try the next one
    }
  }
  return os.tmpdir();
}

async function main(): Promise<number> {
  const sea = await isSea();
  const outDir = writableDir(
    resolve(arg('out') ?? (sea ? dirname(process.execPath) : process.cwd())),
  );
  const io = consoleIO();
  console.log(`HQPlayer Studio — DSP 设置测试 / DSP settings test v${DSPGATE_VERSION}`);
  console.log(
    '逐步临时更改 模式 / 滤波器 / 调制器 / 采样率 / 开关，每一步都需要你按回车，改完立即改回。',
  );
  console.log(
    'Briefly changes mode / filter / shaper / rate / toggles, one step at a time (Enter each), and reverts each one.',
  );
  console.log(
    '不会改动播放列表、音量、输出设备或配置文件。/ Never touches the playlist, volume, output device or configuration.',
  );
  console.log(`输出目录 / output folder: ${outDir}`);

  try {
    const runStamp = stamp();
    const { report, exitCode } = await runDspGate({
      host: arg('host') ?? '127.0.0.1',
      port: Number(arg('port') ?? 4321),
      timeoutMs: Number(arg('timeout') ?? 15000),
      outDir,
      io,
      stamp: runStamp,
    });
    if (report.reachable) {
      const file = join(outDir, `hqp-dspgate-report-${runStamp}.json`);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\n报告 / report: ${file}`);
      console.log('请把这个报告 JSON 发回给开发者（不含曲名、路径或矩阵配置名）。');
      console.log('Send this report back (no titles, paths or matrix profile names in it).');
    }
    return exitCode;
  } finally {
    io.close();
  }
}

void (async () => {
  const code = await main().catch((err: unknown) => {
    console.error(`dspgate failed: ${(err as Error).message}`);
    return 2;
  });
  if (process.platform === 'win32' && process.stdin.isTTY && !flag('no-pause')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((r) => rl.question('\n按回车键退出 / Press Enter to exit…', () => r()));
    rl.close();
  }
  process.exit(code);
})();
