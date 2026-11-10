/**
 * hqp-gatec — Gate C write-command test for HQPlayer Desktop (docs/gate-c-plan.md).
 *
 * Unlike hqp-probe (read-only), this tool DOES send playback and playlist commands — but only
 * the ones approved in the plan, one step at a time, each after the user presses Enter. It backs
 * up HQPlayer's current playlist first and restores it at the end. DSP/output/configuration
 * commands are refused by an allowlist.
 *
 * Options: --host 127.0.0.1  --port 4321  --timeout 5000  --out <dir>  --no-pause
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { consoleIO } from './gatec/console-io';
import { GATEC_VERSION, runGateC } from './gatec/run';

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
  console.log(`HQPlayer Studio — Gate C 写命令测试 / write-command test v${GATEC_VERSION}`);
  console.log('按已批准的计划逐步发送播放与播放列表命令；每一步都需要你按回车。');
  console.log(
    'Sends playback/playlist commands from the approved plan, one step at a time (Enter each).',
  );
  console.log(
    '不会发送任何 DSP、输出或配置命令。/ Never sends DSP, output or configuration commands.',
  );
  console.log(
    '开始前会备份 HQPlayer 当前播放列表，结束时恢复。/ Backs up the playlist first; restores it at the end.',
  );
  console.log(`输出目录 / output folder: ${outDir}`);

  try {
    const { report, exitCode } = await runGateC({
      host: arg('host') ?? '127.0.0.1',
      port: Number(arg('port') ?? 4321),
      timeoutMs: Number(arg('timeout') ?? 5000),
      outDir,
      io,
      stamp: stamp(),
    });
    if (report.reachable) {
      const file = join(outDir, `hqp-gatec-report-${stamp()}.json`);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`\n报告 / report: ${file}`);
      console.log('请把这个报告 JSON 发回给开发者（已脱敏）。备份文件请留在本机。');
      console.log('Send this report back (sanitised). Keep the backup files on this PC.');
    }
    return exitCode;
  } finally {
    io.close();
  }
}

void (async () => {
  const code = await main().catch((err: unknown) => {
    console.error(`gatec failed: ${(err as Error).message}`);
    return 2;
  });
  if (process.platform === 'win32' && process.stdin.isTTY && !flag('no-pause')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((r) => rl.question('\n按回车键退出 / Press Enter to exit…', () => r()));
    rl.close();
  }
  process.exit(code);
})();
