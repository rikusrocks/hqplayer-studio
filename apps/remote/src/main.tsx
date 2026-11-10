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

applyTheme(readStoredTheme());

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <DialogProvider>
          <StudioProvider>
            <App />
          </StudioProvider>
        </DialogProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
