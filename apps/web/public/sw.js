const CACHE_NAME = "quickorder-shell-v2";
const PRECACHE_URLS = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  // Only handle same-origin http(s) requests. This skips chrome-extension://,
  // data:, blob: and cross-origin API calls — none of which belong in the cache.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.origin !== self.location.origin) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  if (!isCacheableRequest(event.request)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => undefined);
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "QuickOrder", body: "You have an order update.", url: "/" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (error) {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
