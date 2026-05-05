/**
 * sw.js — service worker
 * Strategy:
 *  - App shell (HTML/CSS/JS): cache-first, fall back to network
 *  - API calls (Apps Script): network-only (never cache mutations)
 *  - Drive thumbnails: cache-first with stale-while-revalidate
 *
 * Bump CACHE_VERSION whenever app shell files change.
 */

const CACHE_VERSION = 'handover-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/layout.css',
  './css/components.css',
  './css/forms.css',
  './js/app.js',
  './js/router.js',
  './js/state.js',
  './js/api.js',
  './js/config.js',
  './js/validator.js',
  './js/ui.js',
  './js/components.js',
  './js/pages.js',
  './js/utils/dom.js',
  './js/utils/image.js',
  './js/utils/format.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // Use individual adds so SW installs even if some paths 404 during early dev.
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] failed to cache', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Apps Script API: never cache.
  if (url.hostname.endsWith('script.google.com')) return;

  // Drive thumbnails: stale-while-revalidate.
  if (url.hostname === 'drive.google.com') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Same-origin app shell: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === 'basic') {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    if (req.mode === 'navigate') {
      const offline = await caches.match('./index.html');
      if (offline) return offline;
    }
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}
