const CACHE = 'vigia-suite-v15';
const ASSETS = ['/', '/index.html', '/landing.css', '/landing.js', '/sequence-config.js', '/dashboard.html', '/styles.css', '/ble-address.js', '/app.js', '/installer.js', '/firmware-core.js', '/history.js', '/history-core.js', '/history-store.js', '/nvd.js', '/nvd-core.js', '/nvd-client.js', '/nvd-store.js', '/vendor/esptool-js-0.7.0/bundle.js', '/manifest.webmanifest', '/icon.svg', '/assets/monochrome-folds.png', '/product-sequence/desktop/frame-0001.webp', '/product-sequence/mobile/frame-0001.webp'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Otros orígenes (como la API de NVD) no pasan por el service worker: nvd-client.js gestiona su propia caché con la
  // fecha de consulta. La API local y el firmware nunca se sirven desde caché: el instalador verifica la versión publicada.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/firmware/') || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && url.origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
