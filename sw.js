const CACHE = 'family-v1';
const ASSETS = ['./', './index.html'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) { e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({error:'offline'}), {headers:{'Content-Type':'application/json'}}))); return; }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
