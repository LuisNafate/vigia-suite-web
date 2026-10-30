const CACHE = 'vigia-suite-v8';
const ASSETS = ['/', '/index.html', '/landing.css', '/landing.js', '/sequence-config.js', '/dashboard.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/assets/monochrome-folds.png', '/product-sequence/desktop/frame-0001.webp', '/product-sequence/mobile/frame-0001.webp'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
));
self.addEventListener('fetch', event => {
  if (event.request.url.includes('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
