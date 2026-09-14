// Service Worker - Mozzafiato Compras
const CACHE = 'mozzafiato-v2';
const STATIC = ['./manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Peticiones al Script URL o googleapis siempre a red directa
  if (url.includes('script.google.com') || url.includes('googleapis.com')) {
    return;
  }

  // index.html — network first: siempre intenta la red para captar actualizaciones
  // Si falla (sin conexión), usa el cache como respaldo
  if (url.endsWith('/') || url.includes('index.html') || e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Guarda la versión fresca en cache
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Recursos estáticos (íconos, manifest) — cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
