/**
 * hqp-probe — read-only HQPlayer Control API diagnostic (Gate A + Gate B).
 *
 * Double-click hqp-probe.exe on the Windows PC that runs HQPlayer Desktop 6. It connects to
 * 127.0.0.1:4321, sends only side-effect-free commands from the official SDK 6.0.1, and writes
 * a sanitised JSON report next to the executable. It never changes playback, the playlist,
 * volume, DSP settings, configuration or the licence.
 *
 * Options: --host 127.0.0.1  --port 4321  --timeout 3000  --out <dir>  --include-raw  --no-pause
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PROBE_VERSION, runProbe } from './probe';

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

function writeWithFallback(dir: string, name: string, content: string): string {
  for (const target of [dir, join(os.homedir(), 'Desktop'), os.tmpdir()]) {
    try {
      mkdirSync(target, { recursive: true });
      const file = join(target, name);
      writeFileSync(file, content, 'utf8');
      return file;
    } catch {
      // try next location
    }
  }
  throw new Error('Could not write the report anywhere');
}

async function main(): Promise<number> {
  const sea = await isSea();
  const outDir = resolve(arg('out') ?? (sea ? dirname(process.execPath) : process.cwd()));
  const host = arg('host') ?? '127.0.0.1';
  const port = Number(arg('port') ?? 4321);
  const timeoutMs = Number(arg('timeout') ?? 3000);
  const includeRaw = flag('include-raw');

  console.log(`HQPlayer Studio — HQPlayer API 只读探测 / read-only probe v${PROBE_VERSION}`);
  console.log('只发送官方 SDK 6.0.1 中无副作用的查询命令；不会改变播放、队列、音量、DSP 或配置。');
  console.log(`目标 / target: ${host}:${port}\n`);

  const { report, rawTranscript } = await runProbe({
    host,
    port,
    timeoutMs,
    keepRawTranscript: includeRaw,
    log: (line) => console.log(line),
  });

  const name = `hqp-probe-report-${stamp()}.json`;
  const file = writeWithFallback(outDir, name, `${JSON.stringify(report, null, 2)}\n`);
  console.log('');
  if (report.summary.reachable) {
    const e = report.summary.engine;
    console.log(
      `✔ 已连接 / connected — ${e?.product ?? 'HQPlayer'} ${e?.version ?? ''} (${e?.platform ?? '?'})`,
    );
    console.log(
      `✔ 只读命令 / read-only commands: ${report.summary.commandsOk} OK, ${report.summary.commandsFailed} failed`,
    );
    console.log(
      `  Status 订阅推送 / pushes in ${report.statusSubscription.watchMs} ms: ${report.statusSubscription.pushes}`,
    );
  } else {
    console.log(`✘ 无法连接 / not reachable: ${report.gateA.tcpConnect.error ?? ''}`);
    console.log(
      '  请确认 HQPlayer Desktop 已启动。/ Make sure HQPlayer Desktop is running on this PC.',
    );
  }
  console.log(`\n报告 / report: ${file}`);
  console.log('请把这个 JSON 文件发回给开发者。曲名、路径、播放列表名和许可证信息已脱敏。');
  console.log(
    'Send this JSON file back. Titles, paths, playlist names and licence data are redacted.',
  );

  if (includeRaw) {
    const rawFile = writeWithFallback(
      outDir,
      `hqp-probe-raw-${stamp()}.log`,
      rawTranscript
        .map(
          (e) => `${new Date(e.at).toISOString()} ${e.direction.toUpperCase()} ${e.text.trimEnd()}`,
        )
        .join('\n'),
    );
    console.log(`\n⚠ 原始未脱敏记录 / UNSANITISED raw transcript: ${rawFile}`);
    console.log(
      '  可能包含本机路径和曲名，请勿公开分享。/ May contain local paths and titles — do not share publicly.',
    );
  }
  return 0;
}

// No top-level await: the SEA bundle is CommonJS.
void (async () => {
  const code = await main().catch((err: unknown) => {
    console.error(`probe failed: ${(err as Error).message}`);
    return 2;
  });
  if (process.platform === 'win32' && process.stdin.isTTY && !flag('no-pause')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((r) => rl.question('\n按回车键退出 / Press Enter to exit…', () => r()));
    rl.close();
  }
  process.exit(code);
})();
