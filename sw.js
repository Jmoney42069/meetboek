/* Meetboek Mobiel — service worker. Network-first zodat updates altijd
   binnenkomen; valt terug op de cache als je offline bent. In Bluefy (WKWebView)
   is service-worker-support wisselvallig — reken niet op offline daar. */
const CACHE = "meetboek-mobiel-v6";
const ASSETS = ["./", "index.html", "mobile.js", "app.css", "icon.svg", "manifest-mobile.webmanifest"];

self.addEventListener("install", (e) => {
  // Per bestand cachen (addAll is atomair: één 404 zou alles laten mislukken).
  e.waitUntil(caches.open(CACHE).then((c) =>
    Promise.all(ASSETS.map((a) => c.add(a).catch(() => {})))
  ).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then((res) => {
      // Alleen echte, geslaagde eigen responses cachen (geen redirects/errors).
      if (res && res.ok && res.status === 200 && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
