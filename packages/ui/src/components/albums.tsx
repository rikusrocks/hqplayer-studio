import type { AlbumSummary } from '@hqps/contracts';
import type { ReactNode } from 'react';
import { useCapabilityGate, useStudio } from '../data/StudioProvider';
import { useT } from '../i18n/I18nProvider';
import { Icon } from './Icon';
import { Artwork } from './basics';

export function AlbumCard({ album, href }: { album: AlbumSummary; href: string }) {
  const { playAlbum } = useStudio();
  const gate = useCapabilityGate();
  const t = useT();
  const reason = gate('queue.replace');
  const sub = [album.albumArtist, album.year].filter(Boolean).join(' · ');
  return (
    <div className={`hq-album-card${album.available ? '' : ' is-unavailable'}`}>
      <div className="hq-album-card__media">
        <a className="hq-album-card__art" href={href} aria-label={album.title}>
          <Artwork artworkId={album.artworkId} alt="" />
          <span className="hq-album-card__format">{album.formatLabel}</span>
        </a>
        <button
          type="button"
          className="hq-album-card__play"
          onClick={() => void playAlbum(album.id)}
          disabled={!!reason}
          title={reason ?? t('actions.playAlbum')}
          aria-label={`${t('actions.playAlbum')}: ${album.title}`}
        >
          <Icon name="play" size={20} />
        </button>
      </div>
      <a className="hq-album-card__title" href={href} title={album.title}>
        {album.title}
      </a>
      <div className="hq-album-card__sub" title={sub}>
        {sub}
      </div>
    </div>
  );
}

export function AlbumGrid({ children, dense = false }: { children: ReactNode; dense?: boolean }) {
  return <div className={`hq-album-grid${dense ? ' hq-album-grid--dense' : ''}`}>{children}</div>;
}
