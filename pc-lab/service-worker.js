const CACHE = 'vigia-suite-v11';
const ASSETS = ['/', '/index.html', '/landing.css', '/landing.js', '/sequence-config.js', '/dashboard.html', '/styles.css', '/app.js', '/installer.js', '/firmware-core.js', '/vendor/esptool-js-0.7.0/bundle.js', '/manifest.webmanifest', '/icon.svg', '/assets/monochrome-folds.png', '/product-sequence/desktop/frame-0001.webp', '/product-sequence/mobile/frame-0001.webp'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // La API local y el firmware nunca se sirven desde caché: el instalador verifica siempre la versión publicada.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/firmware/') || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && url.origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
