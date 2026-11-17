import { BrandMark, Icon, useI18n, useStudio, type IconName, type MessageKey } from '@hqps/ui';

export const REPO_URL = 'https://github.com/rikusrocks/hqplayer-studio';
export const SITE_URL = 'https://rikus.rocks';

const LINKS: Array<{ href: string; icon: IconName; label: MessageKey; hint: MessageKey }> = [
  { href: REPO_URL, icon: 'external', label: 'about.repo', hint: 'about.repoHint' },
  { href: SITE_URL, icon: 'external', label: 'about.site', hint: 'about.siteHint' },
];

const DISCLAIMER: MessageKey[] = [
  'about.d.unofficial',
  'about.d.asIs',
  'about.d.drm',
  'about.d.online',
  'about.d.unsigned',
];

/** Settings → About: version, the project's links, licence and the disclaimer (its only place). */
export function AboutSettings() {
  const { t } = useI18n();
  const { server } = useStudio();
  return (
    <div className="settings-stack about">
      <div className="settings-block about__hero">
        <BrandMark size={48} />
        <div>
          <h3 className="settings-block__title">
            {t('app.name')}
            <span className="hq-badge hq-badge--warn">beta</span>
          </h3>
          <p className="hint">
            {t('about.version', { version: server?.appVersion ?? '—' })} · {t('about.tagline')}
          </p>
        </div>
      </div>
      <div className="settings-block">
        <div className="settings-block__head">
          <h3 className="settings-block__title">{t('about.links')}</h3>
        </div>
        {LINKS.map((l) => (
          <a
            key={l.href}
            className="setting-row about__link"
            href={l.href}
            target="_blank"
            rel="noreferrer"
          >
            <span className="setting-row__label">
              <strong>{t(l.label)}</strong>
              <span className="hint">
                {t(l.hint)} · <span className="hq-mono">{l.href.replace(/^https:\/\//, '')}</span>
              </span>
            </span>
            <Icon name={l.icon} size={16} />
          </a>
        ))}
        <p className="hint">{t('about.license')}</p>
      </div>
      <div className="settings-block">
        <div className="settings-block__head">
          <h3 className="settings-block__title">{t('about.disclaimer')}</h3>
        </div>
        <ul className="am-notes">
          {DISCLAIMER.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
