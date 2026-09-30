/* PokerOut service worker — makes the app installable and quick to reopen.
   Game data is never cached: it always comes live from the backend. */
const VERSION = 'pokerout-v1';
const SHELL = [
  '/', '/index.html', '/support.js', '/pokerout-core.js', '/manifest.webmanifest',
  '/_ds/organic-2b16b2ba-9c60-4425-a3e5-afe815227d75/styles.css',
  '/_ds/organic-2b16b2ba-9c60-4425-a3e5-afe815227d75/_ds_bundle.js',
  '/assets/pokerout-logo.jpg', '/assets/icon-192.png', '/assets/icon-512.png',
];
const CDN = /^(https:\/\/(unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com))/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname === '/config.json') return;                    // always fresh
  if (url.origin === location.origin) {
    // Network first so deploys show up immediately; cache is the offline fallback.
    const key = req.mode === 'navigate' ? '/index.html' : req;
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then(r => r || caches.match('/index.html'))));
    return;
  }
  if (CDN.test(req.url)) {
    // Libraries & fonts: serve cached, refresh in the background.
    e.respondWith(caches.open(VERSION).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
  // Everything else (the Supabase API & realtime) goes straight to the network.
});
