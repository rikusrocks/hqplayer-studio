export * from './db/database';
export * from './db/migrations';
export * from './errors';
export * from './format';
export * from './normalize';
export * from './repositories/library-repo';
export * from './repositories/playlist-repo';
export * from './repositories/queue-repo';
export * from './repositories/settings-repo';
export * from './repositories/remote-device-repo';
export * from './artwork/artwork-store';
export * from './artwork/generated-cover';
export * from './scanner/metadata';
export * from './scanner/legacy-encoding';
export * from './scanner/album-grouping';
export * from './scanner/scanner';
export * from './seed/demo-seed';

import { join } from 'node:path';
import { ArtworkStore } from './artwork/artwork-store';
import { openDatabase, type Database } from './db/database';
import { LibraryRepository } from './repositories/library-repo';
import { PlaylistRepository } from './repositories/playlist-repo';
import { QueueRepository } from './repositories/queue-repo';
import { SettingsRepository } from './repositories/settings-repo';
import { RemoteDeviceRepository } from './repositories/remote-device-repo';

export interface LibraryContext {
  db: Database;
  library: LibraryRepository;
  playlists: PlaylistRepository;
  queue: QueueRepository;
  settings: SettingsRepository;
  remoteDevices: RemoteDeviceRepository;
  artwork: ArtworkStore;
  close(): void;
}

/** Open the database in `dataDir` (or memory) and wire up all repositories. */
export function openLibrary(dataDir: string | ':memory:', artworkDir?: string): LibraryContext {
  const db = openDatabase(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'studio.sqlite'));
  const library = new LibraryRepository(db);
  const playlists = new PlaylistRepository(db, library);
  const queue = new QueueRepository(db);
  const settings = new SettingsRepository(db);
  const remoteDevices = new RemoteDeviceRepository(db);
  const artwork = new ArtworkStore(
    artworkDir ??
      (dataDir === ':memory:'
        ? join(process.cwd(), '.data', 'tmp-artwork')
        : join(dataDir, 'artwork')),
    library,
  );
  return {
    db,
    library,
    playlists,
    queue,
    settings,
    remoteDevices,
    artwork,
    close: () => db.close(),
  };
}
