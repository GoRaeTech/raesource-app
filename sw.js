/* RaeSource service worker.
   Contractors open this in a truck, often with one bar. The shell is cached on
   install; a client's lead file is served network-first with a cache fallback,
   so a dead signal shows this morning's leads instead of an error page. */
const SHELL = "raesource-shell-v2";
const DATA  = "raesource-data-v1";
const ASSETS = ["./", "./index.html", "./config.js", "./sync.js",
  "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Lead files: network first, fall back to the last good copy.
  if (url.pathname.includes("/leads/")) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(DATA).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request).then(r => r || Response.error()))
    );
    return;
  }
  // Shell: cache first.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
