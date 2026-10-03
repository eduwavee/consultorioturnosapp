import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Instalable como app. Solo en el build: en desarrollo, Vite recarga solo.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('/panel/sw.js', { scope: '/panel/' }).catch(() => {}); });
}
