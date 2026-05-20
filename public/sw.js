// Minimal PWA service worker. Phase 1 only needs the app to be installable;
// real offline caching for DPRs lands in Phase 2 with Workbox.
const CACHE_NAME = "ahc-pm-shell-v1";
const SHELL_ASSETS = ["/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Network-first for navigation; let auth and API calls hit the network always.
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.url.includes("/auth/") || request.url.includes("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((cached) => cached ?? caches.match("/")),
      ),
    );
  }
});
