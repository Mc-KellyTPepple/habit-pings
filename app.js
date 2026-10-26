const C = self.HP_CONFIG;
const $ = (id) => document.getElementById(id);

function deviceKey() {
  let k = null;
  try { k = localStorage.getItem("hp_key"); } catch (_) {}
  if (!k) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    k = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem("hp_key", k); } catch (_) {}
  }
  return k;
}
const KEY = deviceKey();

async function rpc(fn, args) {
  const r = await fetch(`${C.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: C.SUPABASE_KEY, Authorization: `Bearer ${C.SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch (_) {} throw new Error(m); }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const b64ToU8 = (s) => {
  const p = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function subscribe() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(C.VAPID_PUBLIC) });
  await rpc("register_device", {
    p_key: KEY, p_endpoint: sub.endpoint,
    p_p256dh: toB64(sub.getKey("p256dh")), p_auth: toB64(sub.getKey("auth")),
  });
}

async function refreshBanner() {
  const box = $("enable");
  if (!supported) {
    box.hidden = false;
    $("enableMsg").textContent = "This browser can't receive push notifications. On iPhone, add the app to your Home Screen and open it from there.";
    $("enableBtn").hidden = true;
    return;
  }
  if (Notification.permission === "granted") {
    box.hidden = true;
    subscribe().catch(() => {}); // keep subscription fresh
  } else if (Notification.permission === "denied") {
    box.hidden = false;
    $("enableMsg").textContent = "Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.";
    $("enableBtn").hidden = true;
  } else {
    box.hidden = false;
  }
}

$("enableBtn").addEventListener("click", async () => {
  const p = await Notification.requestPermission();
  if (p === "granted") { await subscribe(); }
  refreshBanner();
});

function fmtExpiry(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return { t: "expiring now", soon: true };
  const h = Math.floor(ms / 36e5);
  if (h < 24) return { t: `expires in ${h}h`, soon: true };
  return { t: `expires in ${Math.floor(h / 24)}d ${h % 24}h`, soon: false };
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function load() {
  let habits;
  try { habits = await rpc("list_habits", { p_key: KEY }); } catch (e) { $("list").innerHTML = `<p class="empty">Couldn't load: ${esc(e.message)}</p>`; return; }
  if (!habits.length) { $("list").innerHTML = `<p class="empty">No habits yet. Add one above.</p>`; return; }
  $("list").innerHTML = habits.map((h) => {
    const ex = fmtExpiry(h.expires_at);
    return `<section class="card habit" data-id="${h.id}">
      <div class="row"><h3>${esc(h.name)}</h3>
        <span class="badge ${h.done_today ? "done" : ""}">${h.done_today ? "Done today" : "Pending"}</span></div>
      <p class="meta">${h.times.join(" · ")} · <span class="badge ${ex.soon ? "soon" : ""}">${ex.t}</span></p>
      <div class="actions">
        <button data-act="done" ${h.done_today ? "disabled" : ""}>Mark done</button>
        <button class="ghost" data-act="del">Delete</button>
      </div></section>`;
  }).join("");
}

$("list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".habit").dataset.id;
  btn.disabled = true;
  try {
    if (btn.dataset.act === "done") await rpc("complete_habit", { p_key: KEY, p_id: id });
    else if (confirm("Delete this habit?")) await rpc("delete_habit", { p_key: KEY, p_id: id });
  } catch (err) { alert(err.message); }
  load();
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true;
  try {
    await rpc("register_device", { p_key: KEY });
    await rpc("create_habit", {
      p_key: KEY, p_name: $("name").value,
      p_times: [$("t1").value, $("t2").value, $("t3").value],
      p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    $("name").value = "";
    if (supported && Notification.permission === "default") $("enable").hidden = false;
  } catch (err) { alert(err.message); }
  btn.disabled = false;
  load();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(refreshBanner).catch(refreshBanner);
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "refresh") load(); });
} else refreshBanner();

// refresh when returning to the app; no polling, so no needless Supabase traffic
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
rpc("register_device", { p_key: KEY }).catch(() => {}).finally(load);
