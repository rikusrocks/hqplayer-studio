import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { engineUriToPath, sameEnginePath } from '@hqps/contracts';
import type { PlaylistEntry } from './session';

const PCM_EXT = new Set(['.flac', '.wav', '.aif', '.aiff', '.wv', '.mp3', '.m4a']);
const DSD_EXT = new Set(['.dsf', '.dff']);

export interface TestFiles {
  folder: string;
  /** Three consecutive PCM files (sorted by file name), used for C2/C3.2. */
  pcm: [string, string, string];
  dsd: string | null;
  /** Display names only (shown locally on the user's screen, never written to the report). */
  names: { pcm: string[]; dsd: string | null };
}

/**
 * Pick test files from the user's test folder (top level only, never recursive).
 * Refuses large folders so a mistyped path cannot point Gate C at a whole music library.
 */
export function selectTestFiles(folder: string, maxFiles = 40): TestFiles {
  let names: string[];
  try {
    if (!statSync(folder).isDirectory()) throw new Error('not a folder');
    names = readdirSync(folder);
  } catch {
    throw new Error('找不到这个文件夹 / folder not found');
  }
  const audio = names
    .filter(
      (n) =>
        !n.startsWith('.') &&
        (PCM_EXT.has(extname(n).toLowerCase()) || DSD_EXT.has(extname(n).toLowerCase())),
    )
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (audio.length > maxFiles) {
    throw new Error(
      `文件夹里有 ${audio.length} 个音频文件，请用只含几首测试曲目的小文件夹 / too many audio files (${audio.length})`,
    );
  }
  const pcm = audio.filter((n) => PCM_EXT.has(extname(n).toLowerCase()));
  if (pcm.length < 3)
    throw new Error('需要至少 3 个 PCM 文件（如 FLAC）/ need at least 3 PCM files');
  const dsd = audio.find((n) => DSD_EXT.has(extname(n).toLowerCase())) ?? null;
  const picked = pcm.slice(0, 3) as [string, string, string];
  return {
    folder,
    pcm: picked.map((n) => join(folder, n)) as [string, string, string],
    dsd: dsd ? join(folder, dsd) : null,
    names: { pcm: picked, dsd },
  };
}

/** Label an engine URI by which known file it refers to — the report never contains paths. */
export function labelUri(
  uri: string | null,
  files: TestFiles | null,
  backup: BackupFile | null,
): string | null {
  if (!uri) return null;
  if (files) {
    const i = files.pcm.findIndex((p) => sameEnginePath(uri, p));
    if (i >= 0) return `T${i + 1}`;
    if (files.dsd && sameEnginePath(uri, files.dsd)) return 'DSD';
  }
  if (backup) {
    const j = backup.entries.findIndex((e) => e.uri !== null && e.uri === uri);
    if (j >= 0) return `backup#${j + 1}`;
  }
  return 'other';
}

/** How HQPlayer stored a path we sent (key Gate C finding for PlaylistAdd). */
export function storedForm(engineUri: string | null, sent: string): string {
  if (engineUri === null) return 'missing';
  if (engineUri === sent) return 'as-sent';
  if (engineUri === `file://${sent}`) return 'file://+as-sent';
  if (engineUri === `file:${sent}`) return 'file:+as-sent';
  if (engineUri === `file:///${sent}`) return 'file:///+as-sent';
  if (sameEnginePath(engineUri, engineUriToPath(sent) ?? sent)) return 'equivalent-other-form';
  return 'different-file';
}

// --- backup ----------------------------------------------------------------------------------

export interface BackupFile {
  createdAt: string;
  engine: Record<string, string | null>;
  albumMode: boolean | null;
  transport: string;
  /** Raw Status `track` at the start (engine numbering). */
  statusTrack: number | null;
  /** Engine index (1-based) of the entry matching the playing/selected URI, if found. */
  currentEngineIndex: number | null;
  repeat: string | null;
  random: string | null;
  volume: string | null;
  entries: PlaylistEntry[];
}

function m3uEscape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

/** Standard extended M3U (UTF-8) that HQPlayer can open on its own as a fallback. */
export function toM3u8(backup: BackupFile): string {
  const lines = ['#EXTM3U', `# HQPlayer Studio Gate C backup ${backup.createdAt}`];
  for (const e of backup.entries) {
    if (!e.uri) continue;
    const path = engineUriToPath(e.uri) ?? e.uri;
    const secs = e.lengthMs !== null ? Math.round(e.lengthMs / 1000) : -1;
    lines.push(`#EXTINF:${secs},${m3uEscape(`#${e.engineIndex}`)}`);
    lines.push(path);
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function writeBackup(
  dir: string,
  backup: BackupFile,
  stamp: string,
): { json: string; m3u8: string } {
  const json = join(dir, `hqp-gatec-backup-${stamp}.json`);
  const m3u8 = join(dir, `hqp-gatec-backup-${stamp}.m3u8`);
  writeFileSync(json, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  writeFileSync(m3u8, toM3u8(backup), 'utf8');
  return { json, m3u8 };
}
