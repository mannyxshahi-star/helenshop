self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function notificationPayload(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { body: event.data ? event.data.text() : "" }; } catch (_) { data = {}; }
  }
  return {
    title: data.title || "HelenShop",
    body: data.body || "",
    tag: data.tag || "helenshop",
    url: data.url || (self.registration ? self.registration.scope : "./"),
  };
}

self.addEventListener("push", (event) => {
  const payload = notificationPayload(event);
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    dir: "rtl",
    lang: "fa",
    silent: false,
    vibrate: [90, 40, 90],
    data: { url: payload.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        if (client.url === url) return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});
