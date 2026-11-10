import type { Database } from '../db/database';

export interface RemoteDeviceRow {
  id: string;
  name: string;
  tokenHash: string;
  mediaHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  lastAddress: string | null;
}

interface DbRow {
  id: string;
  name: string;
  token_hash: string;
  media_hash: string;
  created_at: number;
  last_seen_at: number | null;
  last_address: string | null;
}

const toRow = (r: DbRow): RemoteDeviceRow => ({
  id: r.id,
  name: r.name,
  tokenHash: r.token_hash,
  mediaHash: r.media_hash,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  lastAddress: r.last_address,
});

/** Paired Web Remote devices. Holds hashes only — a device token is shown once, at pairing. */
export class RemoteDeviceRepository {
  constructor(private readonly db: Database) {}

  list(): RemoteDeviceRow[] {
    return (
      this.db
        .prepare('SELECT * FROM remote_devices ORDER BY created_at')
        .all() as unknown as DbRow[]
    ).map(toRow);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM remote_devices').get() as { n: number }).n;
  }

  create(device: Omit<RemoteDeviceRow, 'lastSeenAt' | 'lastAddress'>): RemoteDeviceRow {
    this.db
      .prepare(
        `INSERT INTO remote_devices (id, name, token_hash, media_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(device.id, device.name, device.tokenHash, device.mediaHash, device.createdAt);
    return { ...device, lastSeenAt: null, lastAddress: null };
  }

  findByTokenHash(hash: string): RemoteDeviceRow | null {
    const r = this.db.prepare('SELECT * FROM remote_devices WHERE token_hash = ?').get(hash) as
      DbRow | undefined;
    return r ? toRow(r) : null;
  }

  findByMediaHash(hash: string): RemoteDeviceRow | null {
    const r = this.db.prepare('SELECT * FROM remote_devices WHERE media_hash = ?').get(hash) as
      DbRow | undefined;
    return r ? toRow(r) : null;
  }

  touch(id: string, at: number, address: string | null): void {
    this.db
      .prepare('UPDATE remote_devices SET last_seen_at = ?, last_address = ? WHERE id = ?')
      .run(at, address, id);
  }

  /** Returns true when a device was removed. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM remote_devices WHERE id = ?').run(id).changes > 0;
  }
}
