/**
 * hqp-livegate — live-input test for HQPlayer Desktop.
 *
 * Finds out, on the user's own engine, whether HQPlayer can play a live input ("audio:…" entry,
 * e.g. a virtual audio cable that Apple Music plays into) when it is started through the control
 * API, what HQPlayer reports while it does, and whether Windows publishes what Apple Music is
 * playing and lets another program pause / resume it.
 *
 * It replaces HQPlayer's playlist with ONE live-input entry for the duration of the test and puts
 * the original playlist back at the end (backed up to a local file first, like Gate C). It is a
 * separate tool on purpose: it never sends DSP, volume, output, transport-setting or
 * configuration commands.
 *
 * Options: --host 127.0.0.1  --port 4321  --timeout 15000  --out <dir>  --uri audio:…  --no-pause
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { consoleIO } from './gatec/console-io';
import { windowsMediaProbe } from './livegate/media-sessions';
import { LIVEGATE_VERSION, runLiveGate } from './livegate/run';

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
  console.log(`HQPlayer Studio — 实时输入测试 / live-input test v${LIVEGATE_VERSION}`);
  console.log(
    '测试 HQPlayer 能否播放“实时输入”（例如 Apple Music 经虚拟声卡进来的声音），每一步都需要你按回车。',
  );
  console.log(
    'Tests whether HQPlayer can play a live input (e.g. Apple Music through a virtual audio cable), one step at a time (Enter each).',
  );
  console.log(
    '会暂时把播放列表换成一个实时输入条目，结束时恢复。不会改动 DSP、音量、输出设备或配置。',
  );
  console.log(
    'Temporarily replaces the playlist with one live-input entry and restores it at the end. Never touches DSP, volume, output device or configuration.',
  );
  console.log(`输出目录 / output folder: ${outDir}`);

  try {
    const runStamp = stamp();
    const uri = arg('uri');
    const { report, exitCode } = await runLiveGate({
      host: arg('host') ?? '127.0.0.1',
      port: Number(arg('port') ?? 4321),
      timeoutMs: Number(arg('timeout') ?? 15000),
      outDir,
      io,
      stamp: runStamp,
      uris: uri ? [uri] : [],
      media: windowsMediaProbe(),
    });
    if (report.reachable) {
      const file = join(outDir, `hqp-livegate-report-${runStamp}.json`);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\n报告 / report: ${file}`);
      console.log('请把这个报告 JSON 发回给开发者（不含曲名、歌手或路径）。');
      console.log('Send this report back (no titles, artists or paths in it).');
    }
    return exitCode;
  } finally {
    io.close();
  }
}

void (async () => {
  const code = await main().catch((err: unknown) => {
    console.error(`livegate failed: ${(err as Error).message}`);
    return 2;
  });
  if (process.platform === 'win32' && process.stdin.isTTY && !flag('no-pause')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((r) => rl.question('\n按回车键退出 / Press Enter to exit…', () => r()));
    rl.close();
  }
  process.exit(code);
})();
