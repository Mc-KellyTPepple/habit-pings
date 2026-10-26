const C = self.HP_CONFIG;
const $ = (id) => document.getElementById(id);

const isNative = !!(window.Capacitor && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform());

function readKey() { try { return localStorage.getItem("hp_key"); } catch (_) { return null; } }
function saveKey(k) { try { localStorage.setItem("hp_key", k); } catch (_) {} }
function deviceKey() {
  let k = readKey();
  if (!k) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    k = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    saveKey(k);
  }
  return k;
}
let KEY = deviceKey();

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

/* ---------------- channel picker ---------------- */
let channel = "web";

function showChannel(ch) {
  channel = ch;
  $("chWeb").setAttribute("aria-checked", String(ch === "web"));
  $("chApp").setAttribute("aria-checked", String(ch === "fcm"));
  $("panelWeb").hidden = ch !== "web";
  $("panelApp").hidden = ch !== "fcm";
}

async function chooseChannel(ch) {
  showChannel(ch);
  try { await rpc("register_device", { p_key: KEY, p_channel: ch }); } catch (e) { alert(e.message); }
}

/* ---------------- browser (Web Push) ---------------- */
const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function subscribe(setChannel) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(C.VAPID_PUBLIC) });
  const args = { p_key: KEY, p_endpoint: sub.endpoint, p_p256dh: toB64(sub.getKey("p256dh")), p_auth: toB64(sub.getKey("auth")) };
  if (setChannel) args.p_channel = "web";
  await rpc("register_device", args);
}

function refreshWebPanel() {
  const btn = $("enableBtn"), msg = $("enableMsg");
  btn.hidden = false;
  if (!supported) {
    msg.textContent = "This browser can't receive push notifications. On iPhone, add the app to your Home Screen and open it from there.";
    btn.hidden = true;
  } else if (Notification.permission === "granted") {
    msg.textContent = "Browser notifications are on for this device.";
    btn.hidden = true;
    subscribe(false).catch(() => {});
  } else if (Notification.permission === "denied") {
    msg.textContent = "Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.";
    btn.hidden = true;
  } else {
    msg.textContent = "Turn on notifications in this browser to get your pings.";
  }
}

$("enableBtn").addEventListener("click", async () => {
  const p = await Notification.requestPermission();
  if (p === "granted") { try { await subscribe(true); showChannel("web"); } catch (e) { alert(e.message); } }
  refreshWebPanel();
});

/* ---------------- Android app (FCM via Capacitor) ---------------- */
let nativeReady = false;

async function registerNative(askPermission) {
  const PN = window.Capacitor.Plugins.PushNotifications;
  let perm = await PN.checkPermissions();
  if (perm.receive !== "granted" && askPermission) perm = await PN.requestPermissions();
  if (perm.receive !== "granted") { $("nativeMsg").textContent = "Notifications are off. Enable them in Android settings, then tap the button."; $("nativeBtn").hidden = false; return; }
  if (!nativeReady) {
    nativeReady = true;
    try { await PN.createChannel({ id: "default", name: "Habit pings", importance: 5, visibility: 1 }); } catch (_) {}
    await PN.addListener("registration", async (t) => {
      try {
        await rpc("register_device", { p_key: KEY, p_fcm_token: t.value, p_channel: "fcm" });
        $("nativeMsg").textContent = "App notifications are on. Pings will arrive on this phone.";
        $("nativeBtn").hidden = true;
      } catch (e) { $("nativeMsg").textContent = "Couldn't register this phone: " + e.message; }
    });
    await PN.addListener("registrationError", (e) => { $("nativeMsg").textContent = "Push registration failed: " + (e && e.error ? e.error : "unknown error"); });
    await PN.addListener("pushNotificationReceived", () => load());
    await PN.addListener("pushNotificationActionPerformed", (a) => {
      const tok = a && a.notification && a.notification.data && a.notification.data.token;
      if (tok) rpc("touch_by_token", { p_token: tok }).catch(() => {});
      load();
    });
  }
  await PN.register();
}

$("nativeBtn").addEventListener("click", () => registerNative(true).catch((e) => alert(e.message)));

$("linkBtn").addEventListener("click", async () => {
  const code = $("codeIn").value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(code)) { alert("That doesn't look like a link code."); return; }
  try {
    const info = await rpc("device_info", { p_key: code });
    if (!info || !info.channel) { alert("Link code not found. Copy it again from the website."); return; }
    KEY = code; saveKey(code);
    $("codeIn").value = "";
    await registerNative(true);
    load();
  } catch (e) { alert(e.message); }
});

$("copyCode").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(KEY); $("copyCode").textContent = "Copied"; setTimeout(() => ($("copyCode").textContent = "Copy"), 1500); }
  catch (_) { const r = document.createRange(); r.selectNodeContents($("linkCode")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
});

/* ---------------- habits ---------------- */
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
  } catch (err) { alert(err.message); }
  btn.disabled = false;
  load();
});

/* ---------------- start up ---------------- */
$("apkLink").href = C.APK_URL;
$("linkCode").textContent = KEY;
$("chWeb").addEventListener("click", () => chooseChannel("web"));
$("chApp").addEventListener("click", () => chooseChannel("fcm"));

async function start() {
  let info = {};
  try { await rpc("register_device", { p_key: KEY }); info = (await rpc("device_info", { p_key: KEY })) || {}; } catch (_) {}

  if (isNative) {
    // inside the Android app: this device always uses the app channel
    document.querySelector(".seg").hidden = true;
    $("panelWeb").hidden = true; $("panelApp").hidden = false;
    $("appBrowser").hidden = true; $("appNative").hidden = false;
    registerNative(false).catch(() => {});
  } else {
    showChannel(info.channel === "fcm" ? "fcm" : "web");
    refreshWebPanel();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then(refreshWebPanel).catch(() => {});
      navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "refresh") load(); });
    }
  }
  load();
}
start();

// refresh when returning to the app; no polling, so no needless Supabase traffic
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
