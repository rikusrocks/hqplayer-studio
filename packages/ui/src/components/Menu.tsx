import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon';

export type MenuItem =
  | {
      type?: 'item';
      label: string;
      icon?: IconName;
      onSelect: () => void;
      disabled?: boolean;
      title?: string;
      danger?: boolean;
    }
  | { type: 'separator' }
  | { type: 'header'; label: string };

interface MenuButtonProps {
  items: MenuItem[] | (() => MenuItem[]);
  label: string;
  icon?: IconName;
  /** Custom trigger content; defaults to the icon. */
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}

interface Pos {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * Accessible popover menu: opens on click, closes on outside click / Escape / scroll,
 * arrow keys move between items. Positioned `fixed` so it escapes scroll containers.
 */
export function MenuButton({
  items,
  label,
  icon = 'more',
  children,
  className,
  disabled,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const resolved = open ? (typeof items === 'function' ? items() : items) : [];

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.right - m.width;
    if (left < 8) left = Math.min(r.left, vw - m.width - 8);
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const openUp = m.height > below && above > below;
    const maxHeight = Math.max(160, openUp ? above : below);
    const top = openUp ? Math.max(8, r.top - Math.min(m.height, maxHeight) - 4) : r.bottom + 4;
    setPos({ top, left: Math.max(8, left), maxHeight });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
    first?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
    );
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? (idx + 1) % buttons.length
        : (idx - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className ?? 'hq-icon-btn hq-icon-btn--sm'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {children ?? <Icon name={icon} size={18} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          className="hq-menu"
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={
            pos
              ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
              : { top: -9999, left: -9999 }
          }
          onClick={(e) => e.stopPropagation()}
        >
          {resolved.map((item, i) => {
            if (item.type === 'separator')
              return <div key={i} className="hq-menu__sep" role="separator" />;
            if (item.type === 'header')
              return (
                <div key={i} className="hq-menu__header">
                  {item.label}
                </div>
              );
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`hq-menu__item${item.danger ? ' hq-menu__item--danger' : ''}`}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon ? (
                  <Icon name={item.icon} size={16} />
                ) : (
                  <span className="hq-menu__spacer" />
                )}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
