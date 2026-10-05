// network first so updates show up, cache as the offline fallback
const CACHE = 'aashray-v11';
const FILES = ['./', './index.html', './style.css', './triage.js', './data.js', './app.js', './landing.js', './manifest.webmanifest', './icon.svg', './hero-wide.jpg', './hero-m.jpg', './scene.png', './shot-carelist.png', './shot-queue.png', './shot-phone.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(new Request(f, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
