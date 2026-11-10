import '@hqps/ui/styles.css';
import './remote.css';
import {
  DialogProvider,
  I18nProvider,
  StudioProvider,
  ToastProvider,
  applyTheme,
  readStoredTheme,
} from '@hqps/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RemoteAuthGate } from './auth';

applyTheme(readStoredTheme());

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <DialogProvider>
          <RemoteAuthGate>
            {(auth) => (
              <StudioProvider authToken={auth.token} onUnauthorized={auth.lost}>
                <App />
              </StudioProvider>
            )}
          </RemoteAuthGate>
        </DialogProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
