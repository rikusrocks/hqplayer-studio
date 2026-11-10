import { StudioApiError, createStudioClient } from '@hqps/api-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { CheckingView, PairingView } from './PairingView';

/**
 * Web Remote pairing state. On the Studio computer itself no pairing is needed (`trusted`). On a
 * phone, the device token from pairing is kept in localStorage and sent as a header / WebSocket
 * subprotocol — never in the URL. A `#pair=123456` fragment (from the QR code) pre-fills the code;
 * fragments are never sent to the server.
 */
const TOKEN_KEY = 'hqps.remote.token.v1';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode / storage blocked: pairing lasts for this page only
  }
}

/** Code from `#pair=123456`, if the page was opened from the desktop's QR code. */
function codeFromHash(): string {
  const m = /^#pair=(\d{6})$/.exec(window.location.hash);
  return m?.[1] ?? '';
}

function clearPairHash(): void {
  if (window.location.hash.startsWith('#pair=')) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/now`);
  }
}

type GateState =
  | { kind: 'checking' }
  | { kind: 'pair'; revoked: boolean; offline: boolean }
  | {
      kind: 'ready';
      token: string | null;
      trusted: boolean;
      device: { id: string; name: string } | null;
    };

export interface RemoteAuth {
  token: string | null;
  trusted: boolean;
  device: { id: string; name: string } | null;
  /** Forget this device on the server and go back to the pairing screen. */
  unpair: () => Promise<void>;
  /** The server rejected our token (revoked elsewhere). */
  lost: () => void;
}

const AuthContext = createContext<RemoteAuth | null>(null);

export function useRemoteAuth(): RemoteAuth {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useRemoteAuth must be used inside <RemoteAuthGate>');
  return ctx;
}

export function RemoteAuthGate({ children }: { children: (auth: RemoteAuth) => ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'checking' });
  // The QR code's `#pair=` code is only good for the first pairing screen of this page.
  const [initialCode, setInitialCode] = useState(codeFromHash);

  useEffect(() => {
    let cancelled = false;
    const token = readToken();
    const client = createStudioClient({ getAuthToken: () => token });
    client.remote
      .pairingStatus()
      .then((s) => {
        if (cancelled) return;
        if (s.trusted || s.paired) {
          clearPairHash();
          setState({
            kind: 'ready',
            token: s.trusted ? null : token,
            trusted: s.trusted,
            device: s.device,
          });
        } else {
          if (token) writeToken(null);
          setState({ kind: 'pair', revoked: Boolean(token), offline: false });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const offline = err instanceof StudioApiError && err.code === 'network_error';
        // Paired before and the PC is just asleep: open the remote (it shows "offline" and
        // reconnects); otherwise show the pairing screen with the reason.
        if (token && offline) setState({ kind: 'ready', token, trusted: false, device: null });
        else setState({ kind: 'pair', revoked: false, offline });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const lost = useCallback(() => {
    writeToken(null);
    setInitialCode('');
    setState({ kind: 'pair', revoked: true, offline: false });
  }, []);

  const auth = useMemo<RemoteAuth | null>(() => {
    if (state.kind !== 'ready') return null;
    return {
      token: state.token,
      trusted: state.trusted,
      device: state.device,
      lost,
      unpair: async () => {
        const client = createStudioClient({ getAuthToken: () => state.token });
        await client.remote.unpair().catch(() => undefined);
        writeToken(null);
        setInitialCode('');
        setState({ kind: 'pair', revoked: false, offline: false });
      },
    };
  }, [state, lost]);

  if (state.kind === 'checking') return <CheckingView />;
  if (state.kind === 'pair' || !auth) {
    return (
      <PairingView
        initialCode={initialCode}
        revoked={state.kind === 'pair' && state.revoked}
        offline={state.kind === 'pair' && state.offline}
        onPaired={(token, device) => {
          writeToken(token);
          setInitialCode('');
          clearPairHash();
          setState({ kind: 'ready', token, trusted: false, device });
        }}
      />
    );
  }
  return <AuthContext.Provider value={auth}>{children(auth)}</AuthContext.Provider>;
}
