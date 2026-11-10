import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../errors';
import { parseXmlDocument, serializeDocument, unescapeHqpText } from './xml';

describe('parseXmlDocument', () => {
  it('parses a self-closing root with attributes after an XML declaration', () => {
    const doc = parseXmlDocument(
      '<?xml version="1.0" encoding="UTF-8"?><GetInfo name="studio" product="HQPlayer Desktop" version="6.0.1"/>',
    );
    expect(doc.name).toBe('GetInfo');
    expect(doc.attributes).toEqual({
      name: 'studio',
      product: 'HQPlayer Desktop',
      version: '6.0.1',
    });
  });

  it('parses nested children, entities and CJK text', () => {
    const doc = parseXmlDocument(
      `<?xml version="1.0"?>\n<Status state="2" track="1">\n  <metadata song="夜の終わりに &amp; 「光」" artist="林夏" uri="D:\\Music\\a&quot;b.flac"/>\n</Status>`,
    );
    expect(doc.attributes.state).toBe('2');
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]?.attributes.song).toBe('夜の終わりに & 「光」');
    expect(doc.children[0]?.attributes.artist).toBe('林夏');
    expect(doc.children[0]?.attributes.uri).toBe('D:\\Music\\a"b.flac');
  });

  it('collects element text (used by result="Error" responses)', () => {
    const doc = parseXmlDocument('<Play result="Error">no tracks &lt;queued&gt;</Play>');
    expect(doc.text).toBe('no tracks <queued>');
  });

  it('decodes numeric character references', () => {
    expect(parseXmlDocument('<A v="&#x65E5;&#26412;"/>').attributes.v).toBe('日本');
  });

  it('rejects DOCTYPE declarations (no entity expansion surface)', () => {
    expect(() => parseXmlDocument('<!DOCTYPE x [<!ENTITY a "b">]><GetInfo/>')).toThrow(
      ProtocolError,
    );
  });

  it('rejects malformed documents', () => {
    expect(() => parseXmlDocument('<A><B></A>')).toThrow(ProtocolError);
    expect(() => parseXmlDocument('<A x=1/>')).toThrow(ProtocolError);
    expect(() => parseXmlDocument('<A/><B/>')).toThrow(ProtocolError);
    expect(() => parseXmlDocument('<A x="1" x="2"/>')).toThrow(ProtocolError);
    expect(() => parseXmlDocument('<A>')).toThrow(ProtocolError);
  });
});

describe('serializeDocument', () => {
  it('matches the SDK QXmlStreamWriter framing (declaration + element + newline)', () => {
    expect(serializeDocument('GetInfo')).toBe('<?xml version="1.0" encoding="UTF-8"?><GetInfo/>\n');
    expect(serializeDocument('Status', { subscribe: true })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Status subscribe="1"/>\n',
    );
  });

  it('escapes attribute values and never emits raw newlines', () => {
    const out = serializeDocument('PlaylistAdd', { uri: 'D:\\音乐\\"A&B"\n<x>.flac', queued: 1 });
    expect(out).toContain('uri="D:\\音乐\\&quot;A&amp;B&quot;&#10;&lt;x&gt;.flac"');
    expect(out.indexOf('\n')).toBe(out.length - 1);
    expect(parseXmlDocument(out).attributes.uri).toBe('D:\\音乐\\"A&B"\n<x>.flac');
  });

  it('omits undefined/null attributes and writes children', () => {
    expect(
      serializeDocument('PlaylistAdd', { uri: 'x', start: undefined }, [
        { name: 'metadata', attributes: { song: 's' } },
      ]),
    ).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><PlaylistAdd uri="x"><metadata song="s"/></PlaylistAdd>\n',
    );
  });
});

describe('unescapeHqpText', () => {
  it('reverses the server-side double escaping applied to media text (SDK fromEscaped)', () => {
    expect(unescapeHqpText('Simon &amp; Garfunkel &lt;Live&gt;')).toBe('Simon & Garfunkel <Live>');
  });
});
