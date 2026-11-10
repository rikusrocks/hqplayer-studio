import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useT } from '../i18n/I18nProvider';

interface PromptOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  confirmLabel?: string;
}
interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

type DialogState =
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOptions)
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOptions);

interface DialogApi {
  /** In-app replacement for window.prompt (which Electron does not support). */
  prompt: (opts: PromptOptions) => Promise<string | null>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => setDialog({ kind: 'prompt', resolve, ...opts })),
    [],
  );
  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setDialog({ kind: 'confirm', resolve, ...opts })),
    [],
  );
  const api = useMemo(() => ({ prompt, confirm }), [prompt, confirm]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog && <DialogView dialog={dialog} onDone={() => setDialog(null)} />}
    </DialogContext.Provider>
  );
}

function DialogView({ dialog, onDone }: { dialog: DialogState; onDone: () => void }) {
  const t = useT();
  const [value, setValue] = useState(dialog.kind === 'prompt' ? (dialog.defaultValue ?? '') : '');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const cancel = useCallback(() => {
    if (dialog.kind === 'prompt') dialog.resolve(null);
    else dialog.resolve(false);
    onDone();
  }, [dialog, onDone]);

  const accept = () => {
    if (dialog.kind === 'prompt') {
      const v = value.trim();
      if (!v) return;
      dialog.resolve(v);
    } else dialog.resolve(true);
    onDone();
  };

  useEffect(() => {
    if (dialog.kind === 'prompt') {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, cancel]);

  return (
    <div
      className="hq-dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && cancel()}
    >
      <form
        className="hq-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hq-dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          accept();
        }}
      >
        <h2 id="hq-dialog-title" className="hq-dialog__title">
          {dialog.title}
        </h2>
        {dialog.kind === 'prompt' ? (
          <label className="hq-field">
            {dialog.label && <span className="hq-field__label">{dialog.label}</span>}
            <input
              ref={inputRef}
              className="hq-input"
              value={value}
              maxLength={200}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        ) : (
          <p className="hq-dialog__message">{dialog.message}</p>
        )}
        <div className="hq-dialog__actions">
          <button type="button" className="hq-btn hq-btn--ghost" onClick={cancel}>
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="submit"
            className={`hq-btn ${dialog.kind === 'confirm' && dialog.danger ? 'hq-btn--danger' : 'hq-btn--primary'}`}
            disabled={dialog.kind === 'prompt' && !value.trim()}
          >
            {dialog.confirmLabel ?? t('common.ok')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function useDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialogs must be used inside <DialogProvider>');
  return ctx;
}
