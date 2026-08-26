import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles/global.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Register the service worker, but only in a real browser.
 *
 * Inside Capacitor's WebView the assets are already local, so there is nothing
 * for offline caching to win, and registration fails there with an opaque
 * "unknown error occurred when fetching the script".
 *
 * It is also entirely optional: the app works without it. Registration is
 * therefore deferred until after the first render and its failure is swallowed,
 * so a caching nicety can never stop the app from starting.
 */
function registerServiceWorker() {
  const isCapacitor =
    typeof window.Capacitor !== 'undefined' ||
    window.location.protocol === 'capacitor:';

  if (isCapacitor || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error) => console.warn('Service worker not registered:', error));
  });
}

registerServiceWorker();
