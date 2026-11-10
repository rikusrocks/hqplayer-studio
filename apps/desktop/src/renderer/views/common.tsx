import { Artwork, Icon, type IconName } from '@hqps/ui';
import type { ReactNode } from 'react';

export function ViewHeader({
  title,
  subtitle,
  icon,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="view-header">
      <div className="view-header__titles">
        <h1 className="view-header__title">
          {icon && <Icon name={icon} size={22} />}
          {title}
        </h1>
        {subtitle && <div className="view-header__subtitle">{subtitle}</div>}
      </div>
      {children}
      {actions && <div className="view-header__actions">{actions}</div>}
    </div>
  );
}

/** 2×2 artwork mosaic for playlists (falls back to a single placeholder). */
export function Mosaic({ artworkIds, className }: { artworkIds: string[]; className?: string }) {
  const ids = artworkIds.slice(0, 4);
  if (ids.length < 4) {
    return (
      <div className={`mosaic mosaic--single${className ? ` ${className}` : ''}`}>
        <Artwork artworkId={ids[0] ?? null} />
      </div>
    );
  }
  return (
    <div className={`mosaic${className ? ` ${className}` : ''}`}>
      {ids.map((id, i) => (
        <Artwork key={`${id}:${i}`} artworkId={id} />
      ))}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
