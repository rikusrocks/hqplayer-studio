import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from '../components/Icon';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';
export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
}

interface ToastApi {
  push: (level: ToastLevel, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (level: ToastLevel, message: string) => {
      const id = nextId.current++;
      setToasts((list) => {
        // collapse identical consecutive messages
        const last = list[list.length - 1];
        if (last && last.message === message && last.level === level) return list;
        return [...list.slice(-4), { id, level, message }];
      });
      setTimeout(() => dismiss(id), level === 'error' || level === 'warning' ? 8000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="hq-toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`hq-toast hq-toast--${t.level}`}
            role={t.level === 'error' ? 'alert' : 'status'}
          >
            <Icon
              name={t.level === 'success' ? 'check' : t.level === 'info' ? 'info' : 'warning'}
              size={16}
            />
            <span className="hq-toast__msg">{t.message}</span>
            <button
              type="button"
              className="hq-icon-btn hq-icon-btn--sm"
              onClick={() => dismiss(t.id)}
              aria-label="×"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts must be used inside <ToastProvider>');
  return ctx;
}
