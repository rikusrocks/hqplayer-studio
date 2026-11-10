import { ProtocolError } from '../errors';

const NEWLINE = 0x0a;
const DEFAULT_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

type ScanState =
  | 'text'
  | 'lt' // just saw "<", deciding what follows
  | 'start-tag'
  | 'end-tag'
  | 'pi'
  | 'bang' // "<!" seen, deciding comment / cdata / declaration
  | 'comment'
  | 'cdata'
  | 'decl';

/**
 * Splits the HQPlayer control byte stream into complete XML documents.
 *
 * Mirrors the SDK client (ControlInterface::onReadyRead): bytes are consumed line by line
 * (on "\n"), and lines are fed to an incremental scanner until a root element closes. This
 * handles TCP half-packets (a document split over several reads), sticky packets (several
 * documents in one read), multi-line documents and UTF-8 sequences split across reads (we only
 * decode complete lines; "\n" never occurs inside a multi-byte UTF-8 sequence).
 *
 * Not supported (documented limitation): `LibraryPicture` responses that are followed by a raw
 * binary payload. Studio never issues that command over this framer.
 */
export class XmlDocumentFramer {
  private pending: Buffer = Buffer.alloc(0);
  private doc = '';
  private state: ScanState = 'text';
  private depth = 0;
  private sawRoot = false;
  private quote: string | null = null;
  private prev = '';
  private prev2 = '';
  private tagIsSelfClosing = false;
  private marker = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  constructor(private readonly maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES) {}

  /** Feed raw bytes; returns zero or more complete documents (trimmed). */
  push(chunk: Buffer | Uint8Array | string): string[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    const docs: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.pending.indexOf(NEWLINE, start);
      if (nl < 0) break;
      const line = this.decoder.decode(this.pending.subarray(start, nl + 1));
      start = nl + 1;
      this.scan(line, docs);
    }
    this.pending = this.pending.subarray(start);
    if (this.pending.length + this.doc.length > this.maxDocumentBytes) {
      this.reset();
      throw new ProtocolError(`Incoming document exceeds ${this.maxDocumentBytes} bytes`);
    }
    return docs;
  }

  /** Bytes/characters held back waiting for the rest of a document. */
  get bufferedLength(): number {
    return this.pending.length + this.doc.length;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.doc = '';
    this.state = 'text';
    this.depth = 0;
    this.sawRoot = false;
    this.quote = null;
    this.prev = '';
    this.prev2 = '';
    this.marker = '';
  }

  private scan(line: string, out: string[]): void {
    let docStart = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i] as string;
      switch (this.state) {
        case 'text':
          if (ch === '<') this.state = 'lt';
          break;
        case 'lt':
          if (ch === '/') this.state = 'end-tag';
          else if (ch === '?') this.state = 'pi';
          else if (ch === '!') {
            this.state = 'bang';
            this.marker = '';
          } else {
            this.state = 'start-tag';
            this.tagIsSelfClosing = false;
          }
          break;
        case 'start-tag':
          if (this.quote) {
            if (ch === this.quote) this.quote = null;
          } else if (ch === '"' || ch === "'") {
            this.quote = ch;
          } else if (ch === '>') {
            this.tagIsSelfClosing = this.prev === '/';
            this.state = 'text';
            if (!this.tagIsSelfClosing) this.depth++;
            this.sawRoot = true;
            if (this.depth === 0) {
              this.complete(line, docStart, i, out);
              docStart = i + 1;
            }
          }
          break;
        case 'end-tag':
          if (ch === '>') {
            this.state = 'text';
            this.depth = Math.max(0, this.depth - 1);
            if (this.depth === 0 && this.sawRoot) {
              this.complete(line, docStart, i, out);
              docStart = i + 1;
            }
          }
          break;
        case 'pi':
          if (ch === '>' && this.prev === '?') this.state = 'text';
          break;
        case 'bang':
          this.marker += ch;
          if (this.marker === '--') this.state = 'comment';
          else if (this.marker === '[CDATA[') this.state = 'cdata';
          else if (!'--'.startsWith(this.marker) && !'[CDATA['.startsWith(this.marker)) {
            this.state = 'decl';
          }
          break;
        case 'comment':
          if (ch === '>' && this.prev2 + this.prev === '--') this.state = 'text';
          break;
        case 'cdata':
          if (ch === '>' && this.prev2 + this.prev === ']]') this.state = 'text';
          break;
        case 'decl':
          if (ch === '>') this.state = 'text';
          break;
      }
      this.prev2 = this.prev;
      this.prev = ch;
    }
    this.doc += line.slice(docStart);
    // Whitespace between documents (e.g. keep-alive " ") is not a document.
    if (!this.sawRoot && this.state === 'text' && this.doc.trim() === '') this.doc = '';
  }

  private complete(line: string, docStart: number, endIdx: number, out: string[]): void {
    const text = (this.doc + line.slice(docStart, endIdx + 1)).trim();
    this.doc = '';
    this.sawRoot = false;
    this.depth = 0;
    if (text) out.push(text);
  }
}
