/*
 * Service worker del panel. Hace que se pueda instalar como app y muestra una
 * pantalla propia si no hay conexión. A propósito NO guarda en caché la API ni
 * las pantallas: el panel tiene datos clínicos y siempre se pide a la red.
 */
const CACHE = 'panel-offline-v1';
const SIN_CONEXION = '/panel/offline.html';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([SIN_CONEXION, '/panel/favicon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return; // API y archivos: directo a la red
  e.respondWith(fetch(e.request).catch(() => caches.match(SIN_CONEXION)));
});
