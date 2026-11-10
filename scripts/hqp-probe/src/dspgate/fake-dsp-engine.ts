import { escapeXml, type XmlElement } from '@hqps/hqplayer-adapter';
import {
  startFakeHqpServer,
  xmlDoc,
} from '../../../../packages/hqplayer-adapter/src/testing/fake-hqp-server';

/**
 * A SYNTHETIC HQPlayer for the DSP gate tests. The command and attribute names follow SDK 6.0.1
 * and the user's probe report; how the engine reacts to Set* commands is exactly what the real
 * test has to find out, so every such behaviour here is an option, not evidence.
 */
export interface FakeDspOptions {
  /** Does Set* take the list index or the list value (for rates: the rate in Hz)? */
  setTakes?: 'index' | 'value';
  /** Make every item's value equal to its index (the two readings can not be told apart). */
  valuesEqualIndex?: boolean;
  /** Shaper and rate lists (and the remembered selections) differ between PCM and SDM. */
  listsDependOnMode?: boolean;
  /** SetFilter with one value sets both the 1x and the Nx filter (default true). */
  singleFilterSetsBoth?: boolean;
  /** A change during playback restarts the track. */
  restartOnChange?: boolean;
  /** After this many accepted commands of that name, later ones are acknowledged but ignored. */
  ignoreAfter?: { cmd: string; count: number };
  /** Apply this command once, then drop the connection without answering. */
  dropOn?: string;
  matrixProfiles?: string[];
  matrixCurrent?: string;
  playlistLength?: number;
  startPlaying?: boolean;
  pushEveryMs?: number;
}

interface Item {
  index: number;
  name: string;
  value: number;
}

const MODES: Item[] = [
  { index: 0, name: '[source]', value: -1 },
  { index: 1, name: 'PCM', value: 0 },
  { index: 2, name: 'SDM (DSD)', value: 1 },
];
const FILTER_NAMES = [
  'none',
  'IIR',
  'FIR',
  'poly-sinc-lp',
  'poly-sinc-mp',
  'sinc-M',
  'sinc-Mx',
  'closed-form',
];
const SDM_SHAPERS = [
  'DSD5',
  'DSD7',
  'ASDM5',
  'ASDM7',
  'ASDM7EC-light',
  'ASDM7EC-super',
  'ASDM7EC-super 512+fs',
];
const PCM_SHAPERS = ['none', 'TPDF', 'NS9', 'LNS15'];
const SDM_RATES = [0, 2822400, 3072000, 5644800, 6144000, 11289600, 12288000, 22579200, 24576000];
const PCM_RATES = [0, 44100, 48000, 352800, 384000, 705600, 768000];

export interface FakeDspEngine {
  port: number;
  received: XmlElement[];
  /** Current selections as list indexes. */
  dsp(): {
    mode: number;
    filter1x: number;
    filterNx: number;
    shaper: number;
    rate: number;
    invert: number;
    convolution: number;
    adaptive: number;
    matrix: string;
    transport: number;
  };
  close(): Promise<void>;
}

export async function startFakeDspEngine(opts: FakeDspOptions = {}): Promise<FakeDspEngine> {
  const takes = opts.setTakes ?? 'index';
  const eq = !!opts.valuesEqualIndex;
  const filters: Item[] = FILTER_NAMES.map((name, i) => ({
    index: i,
    name,
    value: eq ? i : FILTER_NAMES.length - 1 - i,
  }));
  const shapersFor = (mode: number): Item[] =>
    (opts.listsDependOnMode && mode === 1 ? PCM_SHAPERS : SDM_SHAPERS).map((name, i) => ({
      index: i,
      name,
      value: eq ? i : i + 10,
    }));
  const ratesFor = (mode: number): Item[] =>
    (opts.listsDependOnMode && mode === 1 ? PCM_RATES : SDM_RATES).map((hz, i) => ({
      index: i,
      name: String(hz),
      value: hz,
    }));

  let mode = 2;
  let filter1x = 3;
  let filterNx = 6;
  // Selections are remembered per mode when the lists depend on the mode.
  const perMode = new Map<number, { shaper: number; rate: number }>();
  const sel = () => {
    const key = opts.listsDependOnMode ? mode : -1;
    let v = perMode.get(key);
    if (!v) {
      v = { shaper: key === 1 ? 1 : 6, rate: 0 };
      perMode.set(key, v);
    }
    return v;
  };
  let invert = 0;
  let convolution = 0;
  let adaptive = 0;
  let matrix = opts.matrixCurrent ?? '';
  const playlistLength = opts.playlistLength ?? 3;
  let transport = opts.startPlaying && playlistLength ? 2 : 0;
  let basePos = 0;
  let anchor = Date.now();
  const accepted = new Map<string, number>();
  let dropped = false;

  const position = () => (transport === 2 ? basePos + (Date.now() - anchor) / 10 : basePos);
  const restart = () => {
    basePos = 0;
    anchor = Date.now();
  };
  const activeRate = () => {
    const hz = ratesFor(mode)[sel().rate]?.value ?? 0;
    return hz || (opts.listsDependOnMode && mode === 1 ? 768000 : 24576000);
  };

  const statusDoc = () =>
    xmlDoc(
      `<Status state="${transport}" track="${transport ? 1 : 0}" position="${position().toFixed(3)}" length="${transport ? 300 : 0}" active_mode="${escapeXml(MODES[mode]?.name ?? '')}" active_filter="${escapeXml(filters[filterNx]?.name ?? '')}" active_shaper="${escapeXml(shapersFor(mode)[sel().shaper]?.name ?? '')}" active_rate="${activeRate()}" active_bits="${mode === 1 ? 32 : 1}"/>`,
    );
  const listDoc = (cmd: string, item: string, list: Item[], rates = false) =>
    xmlDoc(
      `<${cmd}>${list
        .map((i) =>
          rates
            ? `<${item} index="${i.index}" rate="${i.value}"/>`
            : `<${item} index="${i.index}" name="${escapeXml(i.name)}" value="${i.value}"${item === 'FiltersItem' ? ` arg="0" description="${escapeXml(`${i.name} filter`)}"` : ''}/>`,
        )
        .join('')}</${cmd}>`,
    );
  const ok = (cmd: string) => xmlDoc(`<${cmd} result="OK"/>`);
  const err = (cmd: string, text: string) => xmlDoc(`<${cmd} result="Error">${text}</${cmd}>`);
  const resolve = (list: Item[], raw: string | undefined): Item | undefined => {
    const n = Number(raw);
    return list.find((i) => (takes === 'index' ? i.index : i.value) === n);
  };

  let pushTimer: ReturnType<typeof setInterval> | null = null;
  // `server` is assigned below; the responders only run after it exists.
  let pushAll: (doc: string) => void = () => undefined;
  let dropAll: () => void = () => undefined;

  /** Shared bookkeeping for every Set command: ignore / drop options, restart while playing. */
  const apply = (cmd: string, change: () => void): string | null => {
    const n = accepted.get(cmd) ?? 0;
    const ignored = opts.ignoreAfter?.cmd === cmd && n >= opts.ignoreAfter.count;
    if (!ignored) {
      change();
      if (opts.restartOnChange && transport === 2) restart();
    }
    accepted.set(cmd, n + 1);
    if (opts.dropOn === cmd && !dropped) {
      dropped = true;
      dropAll();
      return null;
    }
    return ok(cmd);
  };

  const toggle = (cmd: string, set: (v: number) => void) => (req: XmlElement) =>
    apply(cmd, () => set(Number(req.attributes.value)));

  const server = await startFakeHqpServer({
    GetInfo: () =>
      xmlDoc(
        '<GetInfo engine="6.1.0" name="FAKE" platform="Windows" product="Signalyst HQPlayer Desktop" version="6"/>',
      ),
    State: () =>
      xmlDoc(
        `<State state="${transport}" mode="${mode}" filter="${filterNx}" filter1x="${filter1x}" filterNx="${filterNx}" shaper="${sel().shaper}" rate="${sel().rate}" volume="-3.0" active_mode="${mode}" active_rate="${activeRate()}" invert="${invert}" convolution="${convolution}" repeat="0" random="0" adaptive="${adaptive}" filter_junk="0" matrix_profile="${escapeXml(matrix)}"/>`,
      ),
    Status: (req) => {
      if (req.attributes.subscribe === '1' && !pushTimer)
        pushTimer = setInterval(() => pushAll(statusDoc()), opts.pushEveryMs ?? 10);
      return statusDoc();
    },
    GetModes: () => listDoc('GetModes', 'ModesItem', MODES),
    GetFilters: () => listDoc('GetFilters', 'FiltersItem', filters),
    GetShapers: () => listDoc('GetShapers', 'ShapersItem', shapersFor(mode)),
    GetRates: () => listDoc('GetRates', 'RatesItem', ratesFor(mode), true),
    MatrixListProfiles: () =>
      xmlDoc(
        `<MatrixListProfiles>${(opts.matrixProfiles ?? [])
          .map((p) => `<MatrixProfile name="${escapeXml(p)}"/>`)
          .join('')}</MatrixListProfiles>`,
      ),
    MatrixGetProfile: () => xmlDoc(`<MatrixGetProfile value="${escapeXml(matrix)}"/>`),
    MatrixSetProfile: (req) =>
      apply('MatrixSetProfile', () => {
        matrix = req.attributes.value ?? '';
      }),
    PlaylistGet: () =>
      xmlDoc(
        `<PlaylistGet album="0">${Array.from(
          { length: playlistLength },
          (_, i) =>
            `<PlaylistItem index="${i + 1}" uri="file://D:\\Music\\${i + 1}.flac" length="300"/>`,
        ).join('')}</PlaylistGet>`,
      ),
    Play: () => {
      if (!playlistLength) return err('Play', 'empty');
      if (transport === 0) restart();
      transport = 2;
      return ok('Play');
    },
    Stop: () => {
      transport = 0;
      restart();
      return ok('Stop');
    },
    SetMode: (req) => {
      const item = resolve(MODES, req.attributes.value);
      if (!item) return err('SetMode', 'invalid mode');
      return apply('SetMode', () => {
        mode = item.index;
      });
    },
    SetFilter: (req) => {
      const nx = resolve(filters, req.attributes.value);
      const has1x = req.attributes.value1x !== undefined;
      const oneX = has1x ? resolve(filters, req.attributes.value1x) : undefined;
      if (!nx || (has1x && !oneX)) return err('SetFilter', 'invalid filter');
      return apply('SetFilter', () => {
        filterNx = nx.index;
        if (oneX) filter1x = oneX.index;
        else if (opts.singleFilterSetsBoth !== false) filter1x = nx.index;
      });
    },
    SetShaping: (req) => {
      const item = resolve(shapersFor(mode), req.attributes.value);
      if (!item) return err('SetShaping', 'invalid shaper');
      return apply('SetShaping', () => {
        sel().shaper = item.index;
      });
    },
    SetRate: (req) => {
      const item = resolve(ratesFor(mode), req.attributes.value);
      if (!item) return err('SetRate', 'invalid rate');
      return apply('SetRate', () => {
        sel().rate = item.index;
      });
    },
    SetInvert: toggle('SetInvert', (v) => {
      invert = v;
    }),
    SetConvolution: toggle('SetConvolution', (v) => {
      convolution = v;
    }),
    SetAdaptiveVolume: toggle('SetAdaptiveVolume', (v) => {
      adaptive = v;
    }),
  });
  pushAll = (doc) => server.push(doc);
  dropAll = () => {
    for (const s of server.sockets) s.destroy();
  };

  return {
    port: server.port,
    received: server.received,
    dsp: () => ({
      mode,
      filter1x,
      filterNx,
      shaper: sel().shaper,
      rate: sel().rate,
      invert,
      convolution,
      adaptive,
      matrix,
      transport,
    }),
    close: async () => {
      if (pushTimer) clearInterval(pushTimer);
      await server.close();
    },
  };
}
