// DIAL service worker — network-first so updates land immediately,
// cache fallback keeps the app usable offline.
const CACHE = 'dial-v8';
const ASSETS = ['./', './index.html', './dial-v2.css', './dial-v2.js',
  './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return; // don't cache API/CDN calls
  // bypass the HTTP cache for navigations so new deploys land immediately
  // (GitHub Pages sends max-age=600, which would otherwise delay updates)
  const req = e.request.mode === 'navigate' ? new Request(e.request, {cache: 'no-cache'}) : e.request;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(e.request, res.clone());
      }
      return res;
    } catch (_) {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }
  })());
});
