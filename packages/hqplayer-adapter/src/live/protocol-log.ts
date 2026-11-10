import type { TranscriptEntry } from '../protocol/connection';

export interface ProtocolLogEntry {
  /** ms since the first entry of this log */
  t: number;
  dir: 'out' | 'in' | 'event' | 'note';
  text: string;
}

/** Attributes that carry file paths, music metadata or the computer name. */
const PRIVATE_ATTRIBUTES = new Set([
  'uri',
  'path',
  'file',
  'song',
  'title',
  'artist',
  'album',
  'albumartist',
  'composer',
  'performer',
  'genre',
  'name',
  'date',
]);

/**
 * A small, privacy-safe recording of the HQPlayer conversation for "copy diagnostics":
 * file paths, track metadata and the computer name are replaced by stable labels
 * (`uri#3.flac`, `song#7`), repeated Status pushes are collapsed to state changes, and the log
 * keeps only the most recent entries.
 */
export class ProtocolLog {
  private readonly entries: ProtocolLogEntry[] = [];
  private readonly labels = new Map<string, string>();
  private start = 0;
  private lastStatusKey = '';
  private collapsed = 0;

  constructor(private readonly max = 400) {}

  record(entry: TranscriptEntry): void {
    if (entry.direction === 'in' && /<Status[\s>/]/.test(entry.text)) {
      // ~1 push per second while playing: keep only changes of state / track / length
      const key = ['state', 'track', 'tracks_total']
        .map((a) => new RegExp(`\\b${a}="([^"]*)"`).exec(entry.text)?.[1] ?? '')
        .join('|');
      if (key === this.lastStatusKey) {
        this.collapsed += 1;
        return;
      }
      this.lastStatusKey = key;
    }
    this.push(entry.direction, entry.text, entry.at);
  }

  note(text: string): void {
    this.push('note', text, Date.now());
  }

  snapshot(): { entries: ProtocolLogEntry[]; collapsedStatusPushes: number } {
    return { entries: [...this.entries], collapsedStatusPushes: this.collapsed };
  }

  private push(dir: ProtocolLogEntry['dir'], text: string, at: number): void {
    if (this.entries.length === 0) this.start = at;
    const clean = this.sanitize(text.replace(/<\?xml[^>]*\?>/g, '').trim());
    this.entries.push({
      t: at - this.start,
      dir,
      text: clean.length > 1500 ? `${clean.slice(0, 1500)}… (${clean.length} chars)` : clean,
    });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  sanitize(text: string): string {
    const attrs = text.replace(
      /\b([A-Za-z_]+)="([^"]*)"/g,
      (whole, name: string, value: string) => {
        if (!value || !PRIVATE_ATTRIBUTES.has(name.toLowerCase())) return whole;
        if (/^-?\d+(\.\d+)?$/.test(value)) return whole; // flags/counts (e.g. PlaylistGet album="0")
        return `${name}="${this.label(name.toLowerCase(), value)}"`;
      },
    );
    // free text (e.g. an error message) may still contain a path
    return attrs.replace(/(?:file:[^<"]*|[A-Za-z]:\\[^<"]*|\\\\[^<"]*)/g, '<path>');
  }

  private label(kind: string, value: string): string {
    const key = `${kind}\u0000${value}`;
    let label = this.labels.get(key);
    if (!label) {
      const ext = kind === 'uri' || kind === 'path' || kind === 'file' ? extOf(value) : '';
      label = `${kind}#${this.labels.size + 1}${ext}`;
      this.labels.set(key, label);
    }
    return label;
  }
}

function extOf(value: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(value);
  return m ? `.${(m[1] as string).toLowerCase()}` : '';
}
