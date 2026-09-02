/* RaeSource service worker.
   Contractors open this in a truck, often with one bar, so everything must
   survive a dead signal. But "cache first" on the app shell meant a shipped
   fix could never reach a phone that had already opened the app once — the
   old HTML won forever. So: network first for code, cache first for pictures.
   The cache is still there, it is just the fallback rather than the answer. */
const SHELL = "raesource-shell-v3";
const ASSETS = ["./", "./index.html", "./config.js", "./sync.js",
  "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isCode = url =>
  /\.(html|js|json)$/.test(url.pathname) || url.pathname.endsWith("/");

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Never cache the backend; sync.js has its own offline queue for that.
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === "navigate" || isCode(url)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  // Icons and the like: cache first, they do not change.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
