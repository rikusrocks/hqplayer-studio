import { ProtocolError } from '../errors';

/**
 * Minimal, dependency-free XML reader/writer for the HQPlayer control protocol.
 *
 * The protocol (per the official SDK 6.0.1 ControlInterface.cpp) exchanges small XML documents
 * consisting of elements, attributes and occasional text. This parser intentionally supports
 * only that subset and rejects DOCTYPE/entity declarations outright (no XXE surface).
 */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const MAX_DEPTH = 64;
const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_m, ent: string) => {
    switch (ent) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    if (ent.startsWith('#x')) return String.fromCodePoint(parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10));
    throw new ProtocolError(`Unknown XML entity &${ent};`);
  });
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

/**
 * Some HQPlayer string attributes are escaped *again* by the server before being placed in the
 * XML attribute; the SDK applies `fromEscaped()` to artist/album/song/etc. Mirror that.
 */
export function unescapeHqpText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export type AttributeValue = string | number | boolean | null | undefined;

function attrString(attributes: Record<string, AttributeValue>): string {
  let out = '';
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null) continue;
    const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    out += ` ${k}="${escapeXml(s)}"`;
  }
  return out;
}

export interface XmlChildSpec {
  name: string;
  attributes?: Record<string, AttributeValue>;
}

/**
 * Serialise one request document the way the SDK's QXmlStreamWriter does:
 * `<?xml version="1.0" encoding="UTF-8"?><Name attr="v"/>` followed by a newline
 * (QXmlStreamWriter::writeEndDocument appends "\n").
 */
export function serializeDocument(
  name: string,
  attributes: Record<string, AttributeValue> = {},
  children: XmlChildSpec[] = [],
): string {
  const head = `<?xml version="1.0" encoding="UTF-8"?><${name}${attrString(attributes)}`;
  if (children.length === 0) return `${head}/>\n`;
  const inner = children.map((c) => `<${c.name}${attrString(c.attributes ?? {})}/>`).join('');
  return `${head}>${inner}</${name}>\n`;
}

class Cursor {
  pos = 0;
  constructor(readonly src: string) {}
  get done(): boolean {
    return this.pos >= this.src.length;
  }
  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }
  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }
  skipWs(): void {
    while (!this.done && /\s/.test(this.peek())) this.pos++;
  }
  expect(s: string): void {
    if (!this.startsWith(s)) this.fail(`expected "${s}"`);
    this.pos += s.length;
  }
  readUntil(s: string): string {
    const end = this.src.indexOf(s, this.pos);
    if (end < 0) this.fail(`unterminated construct, expected "${s}"`);
    const out = this.src.slice(this.pos, end);
    this.pos = end + s.length;
    return out;
  }
  readName(): string {
    const start = this.pos;
    if (!NAME_START.test(this.peek())) this.fail('expected a name');
    this.pos++;
    while (!this.done && NAME_CHAR.test(this.peek())) this.pos++;
    return this.src.slice(start, this.pos);
  }
  fail(msg: string): never {
    throw new ProtocolError(`XML parse error at ${this.pos}: ${msg}`);
  }
}

function skipMisc(c: Cursor): void {
  for (;;) {
    c.skipWs();
    if (c.startsWith('<?')) {
      c.readUntil('?>');
    } else if (c.startsWith('<!--')) {
      c.pos += 4;
      c.readUntil('-->');
    } else if (c.startsWith('<!')) {
      c.fail('DOCTYPE / declarations are not accepted');
    } else {
      return;
    }
  }
}

function parseElement(c: Cursor, depth: number): XmlElement {
  if (depth > MAX_DEPTH) c.fail('document nested too deeply');
  c.expect('<');
  const name = c.readName();
  const attributes: Record<string, string> = {};
  for (;;) {
    c.skipWs();
    const ch = c.peek();
    if (ch === '/') {
      c.expect('/>');
      return { name, attributes, children: [], text: '' };
    }
    if (ch === '>') {
      c.pos++;
      break;
    }
    if (c.done) c.fail('unterminated start tag');
    const attrName = c.readName();
    c.skipWs();
    c.expect('=');
    c.skipWs();
    const quote = c.peek();
    if (quote !== '"' && quote !== "'") c.fail('attribute value must be quoted');
    c.pos++;
    const raw = c.readUntil(quote);
    if (raw.includes('<')) c.fail('"<" is not allowed in attribute values');
    if (Object.hasOwn(attributes, attrName)) c.fail(`duplicate attribute ${attrName}`);
    attributes[attrName] = decodeEntities(raw.replace(/[\t\n\r]/g, ' '));
  }
  const children: XmlElement[] = [];
  let text = '';
  for (;;) {
    if (c.done) c.fail(`unterminated element <${name}>`);
    if (c.startsWith('</')) {
      c.pos += 2;
      const closing = c.readName();
      if (closing !== name) c.fail(`mismatched closing tag </${closing}> for <${name}>`);
      c.skipWs();
      c.expect('>');
      return { name, attributes, children, text: decodeEntities(text) };
    }
    if (c.startsWith('<!--')) {
      c.pos += 4;
      c.readUntil('-->');
    } else if (c.startsWith('<![CDATA[')) {
      c.pos += 9;
      text += c.readUntil(']]>').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    } else if (c.startsWith('<?')) {
      c.readUntil('?>');
    } else if (c.peek() === '<') {
      children.push(parseElement(c, depth + 1));
    } else {
      const next = c.src.indexOf('<', c.pos);
      const end = next < 0 ? c.src.length : next;
      text += c.src.slice(c.pos, end);
      c.pos = end;
    }
  }
}

/** Parse exactly one XML document and return its root element. */
export function parseXmlDocument(src: string): XmlElement {
  const c = new Cursor(src.charCodeAt(0) === 0xfeff ? src.slice(1) : src);
  skipMisc(c);
  if (c.peek() !== '<') c.fail('expected root element');
  const root = parseElement(c, 0);
  skipMisc(c);
  if (!c.done) c.fail('unexpected content after root element');
  return root;
}

export function findChildren(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

export function attrInt(el: XmlElement | undefined, name: string): number | null {
  const v = el?.attributes[name];
  if (v === undefined || v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function attrFloat(el: XmlElement | undefined, name: string): number | null {
  const v = el?.attributes[name];
  if (v === undefined || v === '') return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function attrStr(el: XmlElement | undefined, name: string): string | null {
  const v = el?.attributes[name];
  return v === undefined || v === '' ? null : v;
}
