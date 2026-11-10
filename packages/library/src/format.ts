import { formatLabel } from '@hqps/contracts';

export interface FormatFields {
  codec: string | null;
  container: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  isDsd: boolean;
  bitrate?: number | null;
  lossless?: boolean | null;
}

const EXT_CODEC: Record<string, string> = {
  flac: 'FLAC',
  dsf: 'DSF',
  dff: 'DFF',
  wav: 'WAV',
  wv: 'WavPack',
  aif: 'AIFF',
  aiff: 'AIFF',
  mp3: 'MP3',
  m4a: 'AAC',
  alac: 'ALAC',
  ogg: 'Vorbis',
  opus: 'Opus',
  ape: 'APE',
};

export const AUDIO_EXTENSIONS = new Set(Object.keys(EXT_CODEC).filter((e) => e !== 'alac'));

export function codecFromExtension(ext: string): string | null {
  return EXT_CODEC[ext.toLowerCase().replace(/^\./, '')] ?? null;
}

/** Short codec name for display: "FLAC", "WAV", "MP3"… */
export function shortCodec(codec: string | null, container: string | null): string | null {
  const c = (codec ?? '').toUpperCase();
  const k = (container ?? '').toUpperCase();
  if (c.includes('FLAC')) return 'FLAC';
  if (c.includes('ALAC')) return 'ALAC';
  if (c.includes('WAVPACK') || k.includes('WAVPACK')) return 'WavPack';
  if (c.includes('MPEG') && c.includes('LAYER 3')) return 'MP3';
  if (c === 'MP3') return 'MP3';
  if (c.includes('AAC')) return 'AAC';
  if (c.includes('PCM') || c === 'WAV' || c === 'AIFF') {
    if (k.includes('AIFF') || c === 'AIFF') return 'AIFF';
    return 'WAV';
  }
  if (k.includes('WAVE')) return 'WAV';
  if (k.includes('AIFF')) return 'AIFF';
  if (codec) return codec;
  return container;
}

function rateKhz(rate: number): string {
  const k = rate / 1000;
  return Number.isInteger(k) ? String(k) : k.toFixed(1);
}

/** "FLAC 24/96", "DSD64", "MP3 320k", "WAV 16/44.1". */
export function trackFormatLabel(f: FormatFields): string {
  if (f.isDsd) return formatLabel('DSD', f.sampleRate, null);
  const codec = shortCodec(f.codec, f.container) ?? 'Audio';
  if ((codec === 'MP3' || codec === 'AAC' || codec === 'Vorbis' || codec === 'Opus') && f.bitrate) {
    return `${codec} ${Math.round(f.bitrate / 1000)}k`;
  }
  if (f.sampleRate && f.bitDepth) return `${codec} ${f.bitDepth}/${rateKhz(f.sampleRate)}`;
  if (f.sampleRate) return `${codec} ${rateKhz(f.sampleRate)} kHz`;
  return codec;
}
