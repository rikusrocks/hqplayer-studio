import type {
  RemoteListenerError,
  RemoteSettings,
  UpdateRemoteSettingsRequest,
} from '@hqps/contracts';
import type { LibraryContext } from '@hqps/library';
import type { FastifyInstance } from 'fastify';
import type { EventHub } from '../event-hub';
import { HttpError } from '../http/errors';
import {
  listLanInterfaces,
  resolveBindAddress,
  systemInterfaces,
  type InterfaceProvider,
} from './lan-address';
import { PairingService, type PairingOptions } from './pairing';

/** app_settings key: `{ enabled, interfaceName, address, port }` of the LAN listener. */
export const REMOTE_LAN_SETTING = 'remote.lan';
export const DEFAULT_REMOTE_PORT = 47321;

interface SavedLan {
  enabled: boolean;
  interfaceName: string | null;
  address: string | null;
  port: number;
}

/** Address the LAN app is bound to. Mutable: `port` is filled in after listen() (port 0). */
export interface LanBinding {
  address: string;
  port: number;
}

export interface RemoteAccessOptions {
  /** LAN port. Default 47321 (same number as the loopback listener, on another address). */
  port?: number;
  interfaces?: InterfaceProvider;
  /**
   * Tests only: bind the LAN app here (e.g. 127.0.0.1, port 0) instead of the chosen private
   * address, so tests never open a port on a real network. Not reachable from bootstrap/env.
   */
  testBindAddress?: string;
  /** Re-check the network every N ms (address changed / port freed). Default 30 s; 0 = off. */
  checkIntervalMs?: number;
  pairing?: PairingOptions;
}

type AppFactory = (binding: LanBinding) => Promise<FastifyInstance>;

/**
 * Owns the Web Remote LAN listener: off by default; when enabled, a second Fastify app (deny-by-
 * default LAN security, no settings/diagnostics routes) listens on one private IPv4 address.
 * Never binds 0.0.0.0, loopback or a public address. Start/stop operations are serialised.
 */
export class RemoteAccessService {
  readonly pairing: PairingService;
  private app: FastifyInstance | null = null;
  /** `address`/`port` = where the app listens; `lanAddress` = the chosen interface address. */
  private binding: (LanBinding & { interfaceName: string; lanAddress: string }) | null = null;
  private error: RemoteListenerError | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly interfacesOf: InterfaceProvider;

  constructor(
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
    private readonly createApp: AppFactory,
    private readonly opts: RemoteAccessOptions = {},
  ) {
    this.pairing = new PairingService(ctx.remoteDevices, opts.pairing);
    this.interfacesOf = opts.interfaces ?? systemInterfaces;
    this.pairing.onChange(() => this.changed());
  }

  private changed(): void {
    this.hub.publish({ type: 'remote.changed' });
  }

  private saved(): SavedLan {
    const v = this.ctx.settings.get<Partial<SavedLan> | null>(REMOTE_LAN_SETTING, null);
    return {
      enabled: v?.enabled === true,
      interfaceName: typeof v?.interfaceName === 'string' ? v.interfaceName : null,
      address: typeof v?.address === 'string' ? v.address : null,
      port: this.opts.port ?? (typeof v?.port === 'number' ? v.port : DEFAULT_REMOTE_PORT),
    };
  }

  /** The running LAN app (tests use `inject`), or null. */
  lanApp(): FastifyInstance | null {
    return this.app;
  }

  /** Re-check the network now (the timer does this every `checkIntervalMs`). */
  recheckNow(): Promise<void> {
    return this.serial(() => this.recheck());
  }

  isListening(): boolean {
    return this.app !== null && this.binding !== null;
  }

  /** Remote URLs for phones (empty while not listening). */
  urls(): string[] {
    if (!this.binding) return [];
    return [`http://${this.binding.address}:${this.binding.port}/remote/`];
  }

  settings(): RemoteSettings {
    const saved = this.saved();
    return {
      enabled: saved.enabled,
      interfaceName: this.binding?.interfaceName ?? saved.interfaceName,
      address: saved.address,
      port: this.binding?.port ?? saved.port,
      state: this.isListening() ? 'listening' : saved.enabled && this.error ? 'error' : 'off',
      error: saved.enabled ? this.error : null,
      urls: this.urls(),
      interfaces: listLanInterfaces(this.interfacesOf),
      pairing: this.isListening() ? this.pairing.describeCode(this.urls()) : null,
      devices: this.pairing.list(),
    };
  }

  /** Apply the saved preference at start-up. Never throws: errors show up in Settings. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.serial(() => this.applySaved());
    const every = this.opts.checkIntervalMs ?? 30_000;
    if (every > 0 && !this.timer) {
      this.timer = setInterval(() => void this.serial(() => this.recheck()), every);
      this.timer.unref?.();
    }
  }

  /** Close the listener (shutdown). The saved preference is kept. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.serial(() => this.closeListener());
  }

  async update(req: UpdateRemoteSettingsRequest): Promise<RemoteSettings> {
    await this.serial(async () => {
      const saved = this.saved();
      if (!req.enabled) {
        this.ctx.settings.set(REMOTE_LAN_SETTING, { ...saved, enabled: false });
        this.pairing.cancelCode();
        this.error = null;
        await this.closeListener();
        return;
      }
      const interfaces = listLanInterfaces(this.interfacesOf);
      let pref = { address: saved.address, interfaceName: saved.interfaceName };
      if (req.address || req.interfaceName) {
        const chosen = interfaces.find((i) =>
          req.address ? i.address === req.address : i.name === req.interfaceName,
        );
        if (!chosen) {
          throw new HttpError(400, 'invalid_request', 'That address is not on this computer', {
            reason: 'address_unavailable',
          });
        }
        if (!chosen.usable) {
          throw new HttpError(
            400,
            'invalid_request',
            'Studio only listens on private LAN addresses (10.x, 172.16–31.x, 192.168.x)',
            { reason: 'address_not_private' },
          );
        }
        pref = { address: chosen.address, interfaceName: chosen.name };
      } else if (!pref.address && !pref.interfaceName) {
        const usable = interfaces.filter((i) => i.usable);
        if (usable.length !== 1) {
          throw new HttpError(400, 'invalid_request', 'Choose the network to listen on', {
            reason: 'choose_interface',
          });
        }
        pref = { address: usable[0]!.address, interfaceName: usable[0]!.name };
      }
      this.ctx.settings.set(REMOTE_LAN_SETTING, { ...saved, ...pref, enabled: true });
      await this.closeListener();
      await this.applySaved();
    });
    return this.settings();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async applySaved(): Promise<void> {
    const saved = this.saved();
    if (!saved.enabled || this.stopped) return;
    const where = resolveBindAddress(saved, listLanInterfaces(this.interfacesOf));
    if (!where.ok) {
      this.setError(where.error);
      return;
    }
    if (where.address !== saved.address) {
      // DHCP gave the chosen interface a new private address: follow it.
      this.ctx.settings.set(REMOTE_LAN_SETTING, { ...saved, address: where.address });
    }
    const binding: LanBinding = {
      address: this.opts.testBindAddress ?? where.address,
      port: saved.port,
    };
    let app: FastifyInstance | null = null;
    try {
      app = await this.createApp(binding);
      await app.listen({ host: binding.address, port: binding.port });
      const addr = app.server.address();
      if (addr && typeof addr === 'object') binding.port = addr.port;
      this.app = app;
      this.binding = { ...binding, interfaceName: where.interfaceName, lanAddress: where.address };
      this.error = null;
      this.changed();
    } catch (err) {
      await app?.close().catch(() => undefined);
      const code = (err as NodeJS.ErrnoException).code;
      this.setError(
        code === 'EADDRINUSE'
          ? 'port_in_use'
          : code === 'EADDRNOTAVAIL'
            ? 'address_unavailable'
            : 'listen_failed',
      );
    }
  }

  private async recheck(): Promise<void> {
    const saved = this.saved();
    if (!saved.enabled || this.stopped) return;
    if (this.isListening() && this.binding) {
      const still = listLanInterfaces(this.interfacesOf).some(
        (i) => i.usable && i.address === this.binding?.lanAddress,
      );
      if (still) return;
      await this.closeListener();
    }
    await this.applySaved();
  }

  private setError(error: RemoteListenerError): void {
    if (this.error === error && !this.app) return;
    this.error = error;
    this.changed();
  }

  private async closeListener(): Promise<void> {
    const app = this.app;
    this.app = null;
    this.binding = null;
    if (app) {
      await app.close();
      this.changed();
    }
  }
}
