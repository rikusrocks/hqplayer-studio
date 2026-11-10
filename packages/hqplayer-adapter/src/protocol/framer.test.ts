import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../errors';
import { XmlDocumentFramer } from './framer';

const DECL = '<?xml version="1.0" encoding="UTF-8"?>';

describe('XmlDocumentFramer', () => {
  it('emits one document per complete newline-terminated line', () => {
    const f = new XmlDocumentFramer();
    expect(f.push(`${DECL}<GetInfo name="x"/>\n`)).toEqual([`${DECL}<GetInfo name="x"/>`]);
    expect(f.bufferedLength).toBe(0);
  });

  it('handles sticky packets (several documents in one chunk)', () => {
    const f = new XmlDocumentFramer();
    const docs = f.push(
      `${DECL}<Play result="OK"/>\n${DECL}<Status state="2"/>\n${DECL}<Stop result="OK"/>\n`,
    );
    expect(docs).toHaveLength(3);
    expect(docs[1]).toContain('<Status state="2"/>');
  });

  it('handles half packets (document split over several reads)', () => {
    const f = new XmlDocumentFramer();
    expect(f.push(`${DECL}<Status state="2" posi`)).toEqual([]);
    expect(f.push('tion="12.5"/')).toEqual([]);
    expect(f.push('>\n')).toEqual([`${DECL}<Status state="2" position="12.5"/>`]);
  });

  it('reassembles UTF-8 characters split across TCP reads', () => {
    const f = new XmlDocumentFramer();
    const bytes = Buffer.from(`${DECL}<Status><metadata song="夜の終わりに"/></Status>\n`, 'utf8');
    const cut = bytes.indexOf(Buffer.from('終', 'utf8')) + 1; // split inside a 3-byte sequence
    expect(f.push(bytes.subarray(0, cut))).toEqual([]);
    const docs = f.push(bytes.subarray(cut));
    expect(docs[0]).toContain('夜の終わりに');
  });

  it('supports documents spanning multiple lines (list responses)', () => {
    const f = new XmlDocumentFramer();
    expect(f.push(`${DECL}<GetModes>\n`)).toEqual([]);
    expect(f.push('  <ModesItem index="0" name="[source]" value="-1"/>\n')).toEqual([]);
    expect(f.push('  <ModesItem index="1" name="PCM" value="0"/>\n')).toEqual([]);
    const docs = f.push('</GetModes>\n');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toContain('<ModesItem index="1"');
  });

  it('ignores keep-alive whitespace between documents', () => {
    const f = new XmlDocumentFramer();
    expect(f.push(' \n')).toEqual([]);
    expect(f.push(`  ${DECL}<State state="0"/>\n`)).toEqual([`${DECL}<State state="0"/>`]);
  });

  it('is not fooled by ">" or "/" inside quoted attributes, comments and CDATA', () => {
    const f = new XmlDocumentFramer();
    const doc = `${DECL}<A t="a > b / c"><!-- x > y --><B><![CDATA[ </A> ]]></B></A>`;
    expect(f.push(`${doc}\n`)).toEqual([doc]);
  });

  it('handles a comment that spans lines', () => {
    const f = new XmlDocumentFramer();
    expect(f.push('<A><!-- line one >\n')).toEqual([]);
    expect(f.push('still comment --></A>\n')).toEqual([
      '<A><!-- line one >\nstill comment --></A>',
    ]);
  });

  it('refuses unbounded documents', () => {
    const f = new XmlDocumentFramer(64);
    expect(() => f.push(`<A>${'x'.repeat(100)}`)).toThrow(ProtocolError);
  });
});
