import type { AudioFormat, CapabilityStatus } from '@hqps/contracts';
import { useState, type ReactNode } from 'react';
import { useStudio } from '../data/StudioProvider';
import { signalPathLabel } from '../format';
import { useT, type MessageKey } from '../i18n/I18nProvider';
import { Icon, type IconName } from './Icon';

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span
      className="hq-spinner"
      role="status"
      aria-label={label}
      style={{ width: size, height: size }}
    />
  );
}

export function Artwork({
  artworkId,
  size = 'thumb',
  alt = '',
  className,
}: {
  artworkId: string | null | undefined;
  size?: 'thumb' | 'full';
  alt?: string;
  className?: string;
}) {
  const { client } = useStudio();
  const src = client.artworkUrl(artworkId, size);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = src && failedSrc !== src;
  return (
    <div className={`hq-artwork${className ? ` ${className}` : ''}`}>
      {showImage ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <div className="hq-artwork__placeholder" aria-hidden="true">
          <Icon name="album" size={28} />
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  icon = 'info',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="hq-empty">
      <Icon name={icon} size={32} />
      <div className="hq-empty__title">{title}</div>
      {hint && <div className="hq-empty__hint">{hint}</div>}
      {action && <div className="hq-empty__action">{action}</div>}
    </div>
  );
}

export function LoadingBlock() {
  const t = useT();
  return (
    <div className="hq-loading">
      <Spinner size={18} />
      <span>{t('common.loading')}</span>
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon="warning"
      title={t('common.error')}
      hint={t('errors.loadFailed', { message: error.message })}
      action={
        onRetry && (
          <button type="button" className="hq-btn" onClick={onRetry}>
            <Icon name="refresh" size={16} />
            {t('common.retry')}
          </button>
        )
      }
    />
  );
}

export function MockBadge() {
  const { isMock } = useStudio();
  const t = useT();
  if (!isMock) return null;
  return (
    <span className="hq-badge hq-badge--mock" title={t('engine.mockTitle')}>
      {t('engine.mock')}
    </span>
  );
}

/** Studio-server reachability + HQPlayer connection, in one compact badge. */
export function ConnectionBadge({ compact = false }: { compact?: boolean }) {
  const { status, realtime } = useStudio();
  const t = useT();
  let tone: 'ok' | 'warn' | 'err';
  let label: string;
  if (realtime !== 'open') {
    tone = 'err';
    label = t('engine.serverUnreachable');
  } else {
    switch (status.connection) {
      case 'connected':
        tone = 'ok';
        label = t('engine.connected');
        break;
      case 'connecting':
        tone = 'warn';
        label = t('engine.connecting');
        break;
      case 'error':
        tone = 'err';
        label = t('engine.error');
        break;
      default:
        tone = 'err';
        label = t('engine.disconnected');
    }
  }
  const title = status.lastError ? `${label} — ${status.lastError}` : label;
  return (
    <span className={`hq-conn hq-conn--${tone}`} title={title} role="status">
      <span className="hq-conn__dot" aria-hidden="true" />
      {!compact && <span className="hq-conn__label">{label}</span>}
      {compact && <span className="hq-visually-hidden">{label}</span>}
    </span>
  );
}

const CAP_STATUS_KEY: Record<CapabilityStatus, MessageKey> = {
  confirmed: 'cap.status.confirmed',
  observed: 'cap.status.observed',
  untested: 'cap.status.untested',
  unsupported: 'cap.status.unsupported',
  simulated: 'cap.status.simulated',
};

export function CapabilityStatusBadge({ status }: { status: CapabilityStatus }) {
  const t = useT();
  return <span className={`hq-badge hq-badge--cap-${status}`}>{t(CAP_STATUS_KEY[status])}</span>;
}

/** "FLAC 24/96 → DSD512". */
export function FormatBadge({
  inputLabel,
  output,
}: {
  inputLabel: string | null | undefined;
  output: AudioFormat | null | undefined;
}) {
  const label = signalPathLabel(inputLabel, output);
  if (!label) return null;
  return (
    <span className="hq-format" title={label}>
      {inputLabel && <span className="hq-format__in">{inputLabel}</span>}
      {inputLabel && output && (
        <span className="hq-format__arrow" aria-hidden="true">
          →
        </span>
      )}
      {output && <span className="hq-format__out">{output.label}</span>}
    </span>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  className,
  scope = 'view',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
  /** Keyboard shortcut target: "/" focuses a view-level search first, then the global one. */
  scope?: 'view' | 'global';
}) {
  const t = useT();
  return (
    <div className={`hq-search${className ? ` ${className}` : ''}`}>
      <Icon name="search" size={16} />
      <input
        type="search"
        className="hq-search__input"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        data-search-input={scope}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="hq-icon-btn hq-icon-btn--sm"
          aria-label={t('common.close')}
          onClick={() => onChange('')}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
