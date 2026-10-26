importScripts("config.js");
const C = self.HP_CONFIG;

function rpc(fn, args) {
  return fetch(`${C.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: C.SUPABASE_KEY, Authorization: `Bearer ${C.SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    keepalive: true,
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data.json(); } catch (_) {}
  event.waitUntil(Promise.all([
    self.registration.showNotification(d.title || "Habit Pings", {
      body: d.body || "Time for your habit",
      tag: d.tag, renotify: true, requireInteraction: true,
      icon: "icon-192.png", badge: "icon-192.png",
      data: { token: d.token },
      actions: [{ action: "done", title: "Done" }],
    }),
    // delivery confirmed -> server stops retrying this reminder
    d.token ? rpc("ack_delivery", { p_token: d.token }).catch(() => {}) : null,
  ]));
});

self.addEventListener("notificationclick", (event) => {
  const token = event.notification.data && event.notification.data.token;
  event.notification.close();
  const jobs = [];
  if (token) jobs.push(rpc(event.action === "done" ? "complete_by_token" : "touch_by_token", { p_token: token }).catch(() => {}));
  if (event.action !== "done") {
    jobs.push(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      if (cs.length) { cs[0].postMessage({ type: "refresh" }); return cs[0].focus(); }
      return self.clients.openWindow("./");
    }));
  }
  event.waitUntil(Promise.all(jobs));
});
