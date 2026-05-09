self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("localserve-shell-v1").then((cache) =>
      cache.addAll(["/", "/v/ravi-canteen", "/manifest.webmanifest"])
    )
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open("localserve-shell-v1").then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((response) => response || caches.match("/")))
  );
});
