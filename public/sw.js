self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", () => {
  // Network-first by omission. The service worker exists to make the PWA
  // installable without caching private file metadata or downloaded content.
});
