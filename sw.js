/* RaeSource service worker.
   Contractors open this in a truck, often with one bar, so everything must
   survive a dead signal. But "cache first" on the app shell meant a shipped
   fix could never reach a phone that had already opened the app once — the
   old HTML won forever. So: network first for code, cache first for pictures.
   The cache is still there, it is just the fallback rather than the answer. */
const SHELL = "raesource-shell-v22";
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
    /* cache: "reload" so this actually is network first.
       GitHub Pages serves the app shell with max-age=600, and a plain fetch()
       here is served straight out of the browser's HTTP cache without touching
       the network — so "network first" quietly meant "up to ten minutes stale".
       A rep who force-quit the browser after a fix shipped still got the old
       build, which is the exact failure this file was written to prevent. */
    e.respondWith(
      fetch(e.request, { cache: "reload" }).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  // Icons and the like: cache first, they do not change.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

/* --- follow-up reminders ------------------------------------------------

   A count on a tab is a to-do list, not a reminder: it only works if the rep
   opens the app. These fire whether or not it is open, which is the whole
   point of telling a customer their team gets reminded.

   The payload is deliberately thin — a count and a couple of builder names.
   Push travels through Apple's and Google's servers, so nothing sensitive
   (bid values, notes, phone numbers) is put in it. */

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const n = d.count || 0;
  const title = n === 1 ? "1 lead to follow up" : `${n} leads to follow up`;
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "Open RaeSource to see who is due.",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: "raesource-followups",     // replaces yesterday's rather than stacking
    renotify: true,
    data: { tab: d.tab || "chase" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || "chase";
  const target = new URL("./index.html?tab=" + tab, self.location).href;
  // Focus the app if it is already open rather than stacking another window.
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then(list => {
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && "focus" in c) {
          c.postMessage({ type: "open-tab", tab: tab });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }));
});
