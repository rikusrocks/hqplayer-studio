import { useCapabilityGate, useStudio } from '@hqps/ui';
import { useEffect, useRef } from 'react';

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

/** Native activation keys must keep working on focused buttons/links. */
function isInteractive(el: Element | null): boolean {
  if (!el) return false;
  return (
    isTypingTarget(el) ||
    el.tagName === 'BUTTON' ||
    el.tagName === 'A' ||
    el.getAttribute('role') === 'menuitem'
  );
}

function focusSearch(): void {
  const view = document.querySelector<HTMLInputElement>('[data-search-input="view"]');
  const global = document.querySelector<HTMLInputElement>('[data-search-input="global"]');
  const target = view ?? global;
  target?.focus();
  target?.select();
}

/**
 * Space = play/pause (not while typing or on a focused control), "/" or Cmd/Ctrl+K = search,
 * Cmd/Ctrl+Left/Right = previous/next. Commands respect capability gating.
 */
export function useKeyboardShortcuts(): void {
  const studio = useStudio();
  const gate = useCapabilityGate();
  const ref = useRef({ studio, gate });
  ref.current = { studio, gate };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const { studio: s, gate: g } = ref.current;
      const active = document.activeElement;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (isTypingTarget(active)) return;

      if (e.key === '/' && !mod && !e.altKey) {
        e.preventDefault();
        focusSearch();
        return;
      }
      if ((e.key === ' ' || e.code === 'Space') && !mod && !e.altKey) {
        if (isInteractive(active)) return;
        e.preventDefault();
        if (s.pending.has('transport')) return;
        const playing = s.status.transport === 'playing';
        if (g(playing ? 'transport.pause' : 'transport.play')) return;
        void s.transport(playing ? 'pause' : 'play');
        return;
      }
      if (mod && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const action = e.key === 'ArrowRight' ? 'next' : 'previous';
        if (g(action === 'next' ? 'transport.next' : 'transport.previous')) return;
        void s.transport(action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
