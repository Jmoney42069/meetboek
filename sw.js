/* Offline-cache voor Meetboek Mobiel: cache-first op de app-schil. */
const CACHE = "meetboek-mobiel-v4";
const ASSETS = ["index.html", "./", "mobile.js", "app.css", "icon.svg", "manifest-mobile.webmanifest"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
