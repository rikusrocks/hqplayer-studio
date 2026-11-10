import net from 'node:net';
import { XmlDocumentFramer } from '../protocol/framer';
import { escapeXml, parseXmlDocument, type XmlElement } from '../protocol/xml';

/**
 * A stateful, SYNTHETIC stand-in for HQPlayer used by tests (Gate C tool, live adapter, Core).
 * Attribute names/shapes follow what HQPlayer Desktop 6 / engine 6.1.0 returned to hqp-probe
 * (1-based indexes, "file://" + raw path URIs, output_delay in µs, tracks_total 0 while stopped).
 * Behaviour that matches real observations: Pause toggles (Gate C), PlaylistClear while a track
 * is playing leaves that track behind and it keeps playing (user report on Studio v0.1.4), Play
 * while playing changes nothing. Everything else is invented for testing and is not evidence.
 */
export interface FakeTrack {
  uri: string;
  song: string;
  lengthSec: number;
}

export interface FakeEngineOptions {
  playlist: FakeTrack[];
  /** Simulated track-seconds per real second (tests compress time). */
  speed?: number;
  pushEveryMs?: number;
  /** Make the engine reject PlaylistAdd for native paths (to test the restore fallback). */
  rejectNativePaths?: boolean;
  volume?: string;
  /**
   * Real HQPlayer (observed 2026-11-10): PlaylistClear while playing/paused keeps the active
   * track in the playlist and keeps playing it. Default true; false = an idealised clear.
   */
  clearKeepsActiveTrack?: boolean;
  /** Start with the first playlist entry playing (HQPlayer already busy when Studio connects). */
  startPlaying?: boolean;
  /**
   * Stop is acknowledged at once but the engine keeps "playing" for this long before it is
   * really stopped (models the v0.1.5 report: a clear right after Stop kept one song).
   */
  stopDelayMs?: number;
  /** SelectTrack during playback is accepted but the engine keeps playing the old track. */
  selectIgnoredWhilePlaying?: boolean;
}

export interface FakeEngine {
  port: number;
  received: XmlElement[];
  playlist(): FakeTrack[];
  state(): { transport: number; current: number; repeat: number; random: number; volume: string };
  /** Someone used the native HQPlayer UI: load this playlist and play its first entry. */
  external(playlist: FakeTrack[]): void;
  close(): Promise<void>;
}

const D = '<?xml version="1.0" encoding="UTF-8"?>';

export async function startFakeEngine(opts: FakeEngineOptions): Promise<FakeEngine> {
  const speed = opts.speed ?? 1;
  let playlist = [...opts.playlist];
  let current = playlist.length ? 1 : 0; // 1-based
  let transport = opts.startPlaying && playlist.length ? 2 : 0; // 0 stopped, 1 paused, 2 playing
  let basePos = 0;
  let anchor = Date.now();
  let repeat = 0;
  let random = 0;
  let volume = opts.volume ?? '-6.02059991327962418';
  const received: XmlElement[] = [];
  const sockets = new Set<net.Socket>();

  const position = () =>
    transport === 2 ? basePos + ((Date.now() - anchor) / 1000) * speed : basePos;
  const setPos = (p: number) => {
    basePos = p;
    anchor = Date.now();
  };
  const tick = () => {
    const t = playlist[current - 1];
    if (transport === 2 && t && position() >= t.lengthSec) {
      if (current < playlist.length) {
        current += 1;
        setPos(position() - t.lengthSec);
      } else {
        transport = 0;
        setPos(0);
      }
    }
  };
  // Like the real engine (observed): anything that is not already a file: URI is stored as "file://" + path.
  const isNative = (uri: string) => !/^file:/i.test(uri);
  const toNative = (uri: string) => (isNative(uri) ? `file://${uri}` : uri);

  const statusDoc = () => {
    tick();
    const t = playlist[current - 1];
    const playing = transport !== 0 && t;
    const attrs = `state="${transport}" track="${transport === 0 ? 0 : current}" tracks_total="${transport === 0 ? 0 : playlist.length}" position="${position().toFixed(3)}" length="${playing ? t.lengthSec : 0}" output_delay="${playing ? 400000 : 0}" active_mode="SDM (DSD)" active_rate="24576000" active_bits="1" track_serial="1" transport_serial="1" volume="${volume}" repeat="${repeat}" random="${random}"`;
    const meta = playing
      ? `<metadata uri="${escapeXml(t.uri)}" song="${escapeXml(t.song)}" samplerate="${t.uri.endsWith('.dsf') ? 2822400 : 48000}" bits="${t.uri.endsWith('.dsf') ? 1 : 24}" sdm="${t.uri.endsWith('.dsf') ? 1 : 0}"/>`
      : '';
    return `${D}<Status ${attrs}>${meta}</Status>\n`;
  };

  const handle = (req: XmlElement, socket: net.Socket, subs: { on: boolean }): string => {
    const a = req.attributes;
    const ok = `${D}<${req.name} result="OK"/>\n`;
    switch (req.name) {
      case 'GetInfo':
        return `${D}<GetInfo engine="6.1.0" name="FAKE" platform="Windows" product="Signalyst HQPlayer Desktop" version="6"/>\n`;
      case 'VolumeRange':
        return `${D}<VolumeRange adaptive="0" enabled="0" max="0.0" min="-12.0"/>\n`;
      case 'State':
        return `${D}<State state="${transport}" mode="2" filter="65" shaper="29" rate="0" volume="${volume}" repeat="${repeat}" random="${random}"/>\n`;
      case 'Status':
        if (a.subscribe === '1' && !subs.on) {
          subs.on = true;
          const timer = setInterval(() => socket.write(statusDoc()), opts.pushEveryMs ?? 50);
          socket.on('close', () => clearInterval(timer));
        }
        return statusDoc();
      case 'PlaylistGet':
        return `${D}<PlaylistGet album="0">${playlist
          .map(
            (t, i) =>
              `<PlaylistItem index="${i + 1}" uri="${escapeXml(t.uri)}" song="${escapeXml(t.song)}" length="${t.lengthSec}"/>`,
          )
          .join('')}</PlaylistGet>\n`;
      case 'Play':
        if (!playlist.length) return `${D}<Play result="Error">empty</Play>\n`;
        if (transport === 0) setPos(0);
        else if (transport === 1) anchor = Date.now();
        transport = 2;
        return ok;
      case 'Pause':
        if (transport === 2) {
          setPos(position());
          transport = 1;
        } else if (transport === 1) {
          anchor = Date.now();
          transport = 2;
        }
        return ok;
      case 'Stop':
        if (opts.stopDelayMs && transport !== 0) {
          setTimeout(() => {
            transport = 0;
            setPos(0);
          }, opts.stopDelayMs);
          return ok;
        }
        transport = 0;
        setPos(0);
        return ok;
      case 'Next':
        if (current < playlist.length) {
          current += 1;
          setPos(0);
        }
        return ok;
      case 'Previous':
        if (position() > 3 || current <= 1) setPos(0);
        else {
          current -= 1;
          setPos(0);
        }
        return ok;
      case 'Seek':
        setPos(Number(a.position));
        return ok;
      case 'SelectTrack': {
        const i = Number(a.index);
        if (i < 1 || i > playlist.length)
          return `${D}<SelectTrack result="Error">index</SelectTrack>\n`;
        if (opts.selectIgnoredWhilePlaying && transport !== 0) return ok;
        current = i;
        setPos(0);
        return ok;
      }
      case 'PlaylistClear': {
        const active = transport !== 0 ? playlist[current - 1] : undefined;
        if (active && opts.clearKeepsActiveTrack !== false) {
          playlist = [active];
          current = 1;
          return ok;
        }
        playlist = [];
        current = 0;
        transport = 0;
        return ok;
      }
      case 'PlaylistAdd': {
        const uri = a.uri ?? '';
        if (opts.rejectNativePaths && isNative(uri))
          return `${D}<PlaylistAdd result="Error">bad uri ${escapeXml(uri)}</PlaylistAdd>\n`;
        if (a.clear === '1') {
          playlist = [];
          current = 0;
        }
        const name = uri.split(/[\\/]/).pop() ?? uri;
        playlist.push({
          uri: toNative(uri),
          song: name,
          lengthSec: name.includes('long') ? 600 : 200,
        });
        if (!current) current = 1;
        if (a.queued === '0') {
          current = playlist.length;
          setPos(0);
          transport = 2;
        }
        return ok;
      }
      case 'PlaylistRemove': {
        const i = Number(a.index);
        if (i < 1 || i > playlist.length)
          return `${D}<PlaylistRemove result="Error">index</PlaylistRemove>\n`;
        if (i === current && transport !== 0)
          return `${D}<PlaylistRemove result="Error">track is playing</PlaylistRemove>\n`;
        playlist.splice(i - 1, 1);
        if (current > playlist.length) current = playlist.length;
        return ok;
      }
      case 'SetRepeat':
        repeat = Number(a.value);
        return ok;
      case 'SetRandom':
        random = Number(a.value);
        return ok;
      case 'Volume':
        volume = a.value ?? volume;
        return ok;
      default:
        return `${D}<${req.name} result="Error">unexpected command in fake</${req.name}>\n`;
    }
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const framer = new XmlDocumentFramer();
    const subs = { on: false };
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      for (const raw of framer.push(chunk)) {
        const req = parseXmlDocument(raw);
        received.push(req);
        socket.write(handle(req, socket, subs));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return {
    port: addr.port,
    received,
    playlist: () => [...playlist],
    state: () => ({ transport, current, repeat, random, volume }),
    external: (next) => {
      playlist = [...next];
      current = playlist.length ? 1 : 0;
      transport = playlist.length ? 2 : 0;
      setPos(0);
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
