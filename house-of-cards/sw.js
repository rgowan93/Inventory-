/* House of Cards — service worker.
   Network-first for our own files (so the newest code always wins when online),
   with a cache fallback for offline. Cross-origin requests (Supabase, Square,
   card images) are left untouched so auth/payments/data are never cached. */
const CACHE = 'hoc-v6';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'House of Cards', body: (e.data && e.data.text()) || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'House of Cards', {
    body: d.body || '', icon: 'logo.png', badge: 'logo.png',
    // stays on screen until the user taps/dismisses it — even if the app is open & focused
    requireInteraction: true, renotify: true, tag: 'hoc-' + Date.now(),
    data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        try { await c.focus(); } catch (_) {}
        try { c.postMessage({ type: 'hoc-navigate', url: url }); } catch (_) {}
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // let cross-origin go straight to the network
  e.respondWith((async () => {
    try {
      const net = await fetch(req);
      try { const c = await caches.open(CACHE); c.put(req, net.clone()); } catch (_) {}
      return net;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const idx = await caches.match('./index.html') || await caches.match('./');
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
