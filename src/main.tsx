import { render } from 'preact';
import { App } from './app/App';
import { trackKeyboard } from './ui/common';
import './styles.css';

trackKeyboard();

// iOS Safari ignores user-scalable=no for its own pinch gesture; block it so pinches reach the canvas.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is best-effort */
    });
  });
}
