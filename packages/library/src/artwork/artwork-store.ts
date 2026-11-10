import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LibraryRepository } from '../repositories/library-repo';

const MAX_ARTWORK_BYTES = 12 * 1024 * 1024;
const ID_RE = /^art_[a-f0-9]{32}$/;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/**
 * Content-addressed artwork cache. Files are copied byte-for-byte (no decoding/resizing in
 * Phase 0, so a first scan never decodes hundreds of high-resolution covers). Ids are content
 * hashes, so the HTTP layer can serve them with immutable caching.
 */
export class ArtworkStore {
  constructor(
    readonly dir: string,
    private readonly library: LibraryRepository,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  static isValidId(id: string): boolean {
    return ID_RE.test(id);
  }

  put(bytes: Uint8Array, mime: string, source: 'embedded' | 'folder' | 'generated'): string | null {
    const normalizedMime = mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime.toLowerCase();
    const ext = EXT_BY_MIME[normalizedMime];
    if (!ext || bytes.byteLength === 0 || bytes.byteLength > MAX_ARTWORK_BYTES) return null;
    // SVG can carry script; only accept SVG we generated ourselves, never from music files.
    if (ext === 'svg' && source !== 'generated') return null;
    const id = `art_${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
    const fileName = `${id}.${ext}`;
    const file = join(this.dir, fileName);
    if (!existsSync(file)) writeFileSync(file, bytes);
    this.library.insertArtwork({
      id,
      mime: normalizedMime,
      byteSize: bytes.byteLength,
      source,
      fileName,
    });
    return id;
  }

  /** Resolve an artwork id to a file on disk. Never accepts paths from callers. */
  resolve(id: string): { file: string; mime: string } | null {
    if (!ArtworkStore.isValidId(id)) return null;
    const row = this.library.getArtwork(id);
    if (!row) return null;
    const file = join(this.dir, row.file_name);
    return existsSync(file) ? { file, mime: row.mime } : null;
  }
}
