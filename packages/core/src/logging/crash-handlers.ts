import type { StudioLog } from './studio-log';

export interface CrashHandlerOptions {
  /**
   * After an uncaught exception has been written to a crash report. The Electron app keeps
   * running (like Electron's own default) and tells the user; the dev server exits.
   */
  onUncaught?: (err: unknown, reportName: string | null) => void;
}

/**
 * Capture errors nothing else caught: an uncaught exception becomes a crash report in the log
 * folder; an unhandled promise rejection is logged as an error. Returns a function that removes
 * the handlers.
 */
export function installCrashHandlers(log: StudioLog, opts: CrashHandlerOptions = {}): () => void {
  const onException = (err: unknown) => {
    let name: string | null = null;
    try {
      name = log.crash('uncaught-exception', { error: err });
    } catch {
      // the crash handler must never throw
    }
    opts.onUncaught?.(err, name);
  };
  const onRejection = (reason: unknown) => {
    try {
      const message =
        reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      const where = reason instanceof Error ? (reason.stack?.split('\n')[1]?.trim() ?? '') : '';
      log.error('process', 'unhandled promise rejection', {
        error: message,
        at: where || undefined,
      });
    } catch {
      // ignore
    }
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}
