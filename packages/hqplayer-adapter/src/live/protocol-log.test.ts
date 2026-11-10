import { describe, expect, it } from 'vitest';
import { ProtocolLog } from './protocol-log';

const at = (n: number) => 1_000_000 + n;

describe('ProtocolLog (copy diagnostics)', () => {
  it('replaces paths, metadata and the computer name with stable labels', () => {
    const log = new ProtocolLog();
    log.record({
      direction: 'out',
      at: at(0),
      text: '<PlaylistAdd uri="D:\\音乐\\林夏\\01 光.flac" queued="1"/>',
    });
    log.record({
      direction: 'in',
      at: at(5),
      text: '<?xml version="1.0"?><PlaylistGet album="0"><PlaylistItem index="1" uri="file://D:\\音乐\\林夏\\01 光.flac" song="光" artist="林夏" length="200"/></PlaylistGet>',
    });
    log.record({
      direction: 'in',
      at: at(9),
      text: '<GetInfo name="DESKTOP-ABC" engine="6.1.0"/>',
    });
    log.record({
      direction: 'in',
      at: at(12),
      text: '<PlaylistAdd result="Error">cannot open D:\\音乐\\x y.dsf</PlaylistAdd>',
    });
    const text = JSON.stringify(log.snapshot());
    expect(text).not.toMatch(/音乐|林夏|光|DESKTOP|x y/);
    expect(text).toMatch(/uri=\\"uri#1\.flac\\"/);
    expect(text).toMatch(/album=\\"0\\"/); // numeric flag kept
    expect(text).toMatch(/engine=\\"6\.1\.0\\"/);
    expect(text).toMatch(/cannot open <path>/);
    expect(log.snapshot().entries.map((e) => e.t)).toEqual([0, 5, 9, 12]);
  });

  it('collapses repeated Status pushes to state/track changes and keeps the newest entries', () => {
    const log = new ProtocolLog(5);
    const status = (state: number, track: number, pos: number) =>
      `<Status state="${state}" track="${track}" tracks_total="3" position="${pos}"/>`;
    for (let i = 0; i < 10; i += 1)
      log.record({ direction: 'in', at: at(i), text: status(2, 1, i) });
    log.record({ direction: 'in', at: at(20), text: status(0, 0, 0) });
    log.note('stopped confirmed after 900 ms');
    const snap = log.snapshot();
    expect(snap.collapsedStatusPushes).toBe(9);
    expect(snap.entries.map((e) => e.dir)).toEqual(['in', 'in', 'note']);
    for (let i = 0; i < 10; i += 1) log.note(`n${i}`);
    expect(log.snapshot().entries).toHaveLength(5);
  });
});
