import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Synthetic, licence-safe audio files for tests and benchmarks. Nothing here is a recording:
 * WAV bodies are silence, tags are invented.
 */

/** Build a tiny, valid PCM WAV file with RIFF INFO tags (license-safe synthetic test data). */
export function makeWav(
  tags: { title?: string; artist?: string; album?: string; track?: string },
  ms = 120,
): Buffer {
  const sampleRate = 44100;
  const channels = 2;
  const bits = 16;
  const dataBytes = Math.floor((sampleRate * ms) / 1000) * channels * (bits / 8);
  const infoChunks: Buffer[] = [];
  const sub = (id: string, value?: string) => {
    if (!value) return;
    let body = Buffer.from(`${value}\0`, 'utf8');
    if (body.length % 2) body = Buffer.concat([body, Buffer.alloc(1)]);
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(Buffer.byteLength(`${value}\0`, 'utf8'), 4);
    infoChunks.push(h, body);
  };
  sub('INAM', tags.title);
  sub('IART', tags.artist);
  sub('IPRD', tags.album);
  sub('ITRK', tags.track);
  const info = Buffer.concat([Buffer.from('INFO', 'ascii'), ...infoChunks]);
  const list = Buffer.alloc(8);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(info.length, 4);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE((sampleRate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(dataBytes, 4);
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    fmt,
    list,
    info,
    dataHeader,
    Buffer.alloc(dataBytes),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

export interface SyntheticTreeOptions {
  artists: number;
  albumsPerArtist: number;
  tracksPerAlbum: number;
  /** Audio length per file; keep tiny for large trees (bytes ≈ 176 per ms). */
  ms?: number;
}

/** Artist/Album (Year)/NN Title.wav — mixes CJK and Latin names like a real library. */
export function writeSyntheticTree(root: string, o: SyntheticTreeOptions): string[] {
  const files: string[] = [];
  const names = ['林夏', '月見カルテット', 'Aurora Ensemble', 'Nodal', '紅葉 Trio', 'Saltwater'];
  for (let a = 0; a < o.artists; a += 1) {
    const artist = `${names[a % names.length]} ${a}`;
    for (let b = 0; b < o.albumsPerArtist; b += 1) {
      const album = `Album ${a}-${b} 「第${b}集」`;
      const dir = join(root, artist, `${album} (${2000 + (b % 25)})`);
      mkdirSync(dir, { recursive: true });
      for (let t = 1; t <= o.tracksPerAlbum; t += 1) {
        const title = `Song ${t} 歌 ${a}.${b}`;
        const file = join(dir, `${String(t).padStart(2, '0')} ${title}.wav`);
        writeFileSync(file, makeWav({ title, artist, album, track: String(t) }, o.ms ?? 2));
        files.push(file);
      }
    }
  }
  return files;
}
