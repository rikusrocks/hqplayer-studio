import net from 'node:net';
import { XmlDocumentFramer } from '../protocol/framer';
import { parseXmlDocument, type XmlElement } from '../protocol/xml';

/**
 * A tiny TCP server that speaks the *shape* of the HQPlayer control protocol as documented by
 * SDK 6.0.1, for automated tests only. Its responses are SYNTHETIC — they are not recordings
 * of a real HQPlayer Desktop 6 and must never be cited as evidence of engine behaviour.
 */
export type FakeResponder = (
  request: XmlElement,
  socket: net.Socket,
) => string | string[] | null | undefined | Promise<string | string[] | null | undefined>;

export interface FakeHqpServer {
  port: number;
  received: XmlElement[];
  sockets: Set<net.Socket>;
  push(doc: string): void;
  close(): Promise<void>;
}

const DECL = '<?xml version="1.0" encoding="UTF-8"?>';

export function xmlDoc(body: string): string {
  return `${DECL}${body}\n`;
}

export async function startFakeHqpServer(
  responders: Record<string, FakeResponder>,
  options: { splitWrites?: boolean } = {},
): Promise<FakeHqpServer> {
  const received: XmlElement[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const framer = new XmlDocumentFramer();
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', async (chunk) => {
      for (const raw of framer.push(chunk)) {
        const req = parseXmlDocument(raw);
        received.push(req);
        const responder = responders[req.name];
        const out = responder ? await responder(req, socket) : xmlDoc(`<${req.name} result="OK"/>`);
        if (!out) continue;
        for (const doc of Array.isArray(out) ? out : [out]) {
          if (options.splitWrites && doc.length > 4) {
            const mid = Math.floor(doc.length / 2);
            socket.write(doc.slice(0, mid));
            setTimeout(() => socket.write(doc.slice(mid)), 5);
          } else {
            socket.write(doc);
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    received,
    sockets,
    push(doc: string) {
      for (const s of sockets) s.write(doc);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
