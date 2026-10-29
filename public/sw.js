/* CRCMZ Trip service worker: only for "Share to CRCMZ Trip" (the manifest's share_target).
   The phone's share sheet POSTs the photos to /share; this keeps them in a cache and opens
   the page, which asks whether they're receipts (Split) or a moment. Every other request
   goes to the network untouched: nothing is cached or served offline. */
const SHARE_CACHE = 'crcmz-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share') return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0).slice(0, 30);
      const cache = await caches.open(SHARE_CACHE);
      for (const k of await cache.keys()) await cache.delete(k);
      const list = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const key = `/__shared/${Date.now()}-${i}`;
        await cache.put(key, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `shared-${i}`) } }));
        list.push(key);
      }
      await cache.put('/__shared/list', new Response(JSON.stringify({ files: list, text: String(form.get('text') || form.get('title') || '').slice(0, 1000), at: Date.now() }), { headers: { 'content-type': 'application/json' } }));
      return Response.redirect('/?shared=1', 303);
    } catch (e) {
      return Response.redirect('/?shared=failed', 303);
    }
  })());
});
