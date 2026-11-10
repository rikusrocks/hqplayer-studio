import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, schemaVersion } from './migrations';

describe('migration 5: artwork from online cover sources', () => {
  it('rebuilds artwork_cache without losing covers or the album → cover links', () => {
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    db.exec('PRAGMA foreign_keys = ON');
    // A database as version 0.3.0 left it (migrations 1–4).
    db.exec(`CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
    for (const m of MIGRATIONS.filter((m) => m.id <= 4)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 0)').run(
        m.id,
        m.name,
      );
    }
    const art = db.prepare(
      'INSERT INTO artwork_cache (id, mime, byte_size, source, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    art.run('art_a', 'image/jpeg', 10, 'folder', 'art_a.jpg', 1);
    art.run('art_b', 'image/png', 20, 'embedded', 'art_b.png', 2);
    const album = db.prepare(
      `INSERT INTO albums (id, title, album_artist, artwork_id, album_group_key, created_at, updated_at)
       VALUES (?, ?, 'Lin Xia', ?, ?, 0, 0)`,
    );
    album.run('al_1', 'With Folder Art', 'art_a', 'k1');
    album.run('al_2', 'With Embedded Art', 'art_b', 'k2');
    album.run('al_3', 'No Art', null, 'k3');
    expect(() => art.run('art_c', 'image/jpeg', 1, 'online', 'art_c.jpg', 3)).toThrow();

    expect(migrate(db)).toEqual(MIGRATIONS.filter((m) => m.id > 4).map((m) => m.id));
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.id);

    expect(db.prepare('SELECT id, artwork_id FROM albums ORDER BY id').all()).toEqual([
      { id: 'al_1', artwork_id: 'art_a' },
      { id: 'al_2', artwork_id: 'art_b' },
      { id: 'al_3', artwork_id: null },
    ]);
    expect(
      db
        .prepare('SELECT id, mime, byte_size, source, file_name FROM artwork_cache ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'art_a', mime: 'image/jpeg', byte_size: 10, source: 'folder', file_name: 'art_a.jpg' },
      { id: 'art_b', mime: 'image/png', byte_size: 20, source: 'embedded', file_name: 'art_b.png' },
    ]);
    // the new source is accepted, others still are not, and the foreign key still works
    db.prepare(
      'INSERT INTO artwork_cache (id, mime, byte_size, source, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('art_c', 'image/jpeg', 1, 'online', 'art_c.jpg', 3);
    expect(() =>
      db
        .prepare(
          'INSERT INTO artwork_cache (id, mime, byte_size, source, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('art_d', 'image/jpeg', 1, 'elsewhere', 'art_d.jpg', 4),
    ).toThrow();
    db.prepare("UPDATE albums SET artwork_id = 'art_c' WHERE id = 'al_3'").run();
    db.prepare("DELETE FROM artwork_cache WHERE id = 'art_c'").run();
    expect(db.prepare("SELECT artwork_id FROM albums WHERE id = 'al_3'").get()).toEqual({
      artwork_id: null,
    });
    expect(() =>
      db.prepare("UPDATE albums SET artwork_id = 'nope' WHERE id = 'al_3'").run(),
    ).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});
